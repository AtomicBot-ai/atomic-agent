import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../approval/approval-gate.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { countLines, firstLine, isShrink } from "./fs-replace-guard.js";
import { buildOsFsRestoreTool } from "./fs-restore.js";
import {
  FileRestoreStore,
  RESTORE_COPY_CAP,
  RESTORE_MAX_BYTES,
  restoreKey,
} from "./fs-restore-store.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { registerOsTools } from "./index.js";

/**
 * F36. Two live failures (Gemma 4 31B, 2026-09-15): the model wrote
 * `projects.json` over the user's data file without listing the folder,
 * and a 9-row `sales.csv` over a 2,401-row dataset. Both files were
 * inputs the request named; both were gone. The rules pinned here: the
 * write still lands (warn-only), the previous content is saved first,
 * the result says so — loudly on a ≥ 80 % shrink or a changed header,
 * quietly otherwise — and `os.fs.restore` brings the bytes back.
 *
 * F43. The copies are keyed by WORKING DIRECTORY, not session: a fusion
 * worker is its own ephemeral session, and the worker sent to restore
 * `sales.csv` was not the one that replaced it. Only the created set
 * stays per session.
 */
describe("replace guard (F36)", () => {
  let dir: string;
  let stateDir: string;
  let store: FileRestoreStore;
  let prompts: ApprovalRequest[];
  let gate: ApprovalGate;
  /** `<stateDir>/restore/<key of dir>` — where this working directory's copies live. */
  const copiesDir = (): string => join(stateDir, "restore", restoreKey(dir));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-replace-guard-"));
    stateDir = await mkdtemp(join(tmpdir(), "atomic-replace-state-"));
    store = new FileRestoreStore(join(stateDir, "restore"));
    prompts = [];
    gate = new ApprovalGate({
      emit: (req) => {
        prompts.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  function ctx(sessionId = "s-guard"): ToolContext {
    return {
      workingDir: dir,
      sessionId,
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  /** `null` builds the tools with no store wired — the embedder / plain-test shape. */
  function tools(restore: FileRestoreStore | null = store) {
    const options = {
      approvals: gate,
      approvalRequired: true,
      ...(restore === null ? {} : { restore }),
    };
    return {
      write: buildOsFsWriteTool(options),
      edit: buildOsFsEditTool(options),
      patch: buildOsFsPatchTool(options),
      restore: buildOsFsRestoreTool(options),
    };
  }

  function csv(rows: number, header = "id,name,amount"): string {
    const lines = [header];
    for (let i = 1; i <= rows; i++) lines.push(`${i},row ${i},${i * 10}`);
    return `${lines.join("\n")}\n`;
  }

  describe("os.fs.write", () => {
    it("announces a shrink with a changed header loudly, saves the copy, and names the restore call", async () => {
      const before = csv(2401);
      await writeFile(join(dir, "sales.csv"), before, "utf8");
      const after = csv(9, "sku,qty");
      const result = await tools().write.run(
        { path: "sales.csv", content: after },
        ctx(),
      );
      expect(result.status).toBe("ok");
      const [note, wrote] = result.summary.split("\n");
      expect(note).toBe(
        '⚠ replaced the user\'s file `sales.csv` (2,402 lines → 10, header changed); the previous content is saved — `os.fs.restore {"path":"sales.csv"}` brings it back',
      );
      // The "(replace)" wording carries the counts too.
      expect(wrote).toBe(
        `wrote ${after.length} bytes to ${join(dir, "sales.csv")} (replace, 2,402 lines → 10)`,
      );
      expect(result.details.replaced).toMatchObject({
        path: join(dir, "sales.csv"),
        display: "sales.csv",
        linesBefore: 2402,
        linesAfter: 10,
        shrunk: true,
        headerChanged: true,
        saved: "saved",
        copy: "1-sales.csv",
      });
      expect(result.details.previousLines).toBe(2402);
      expect(result.details.lines).toBe(10);
      // The write landed anyway: warn-only.
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(after);
      const copy = join(copiesDir(), "1-sales.csv");
      expect(await readFile(copy, "utf8")).toBe(before);
      // The manifest names the working directory for a human reading the folder.
      expect(
        JSON.parse(await readFile(join(copiesDir(), "manifest.json"), "utf8")),
      ).toMatchObject({
        version: 2,
        workingDir: dir,
        copies: [{ n: 1, file: "1-sales.csv", tool: "os.fs.write", sessionId: "s-guard" }],
      });
    });

    it("is loud on a header change alone (a .json whose first line moved)", async () => {
      await writeFile(
        join(dir, "projects.json"),
        '[{"id": 1, "name": "alpha"},\n{"id": 2, "name": "beta"}]\n',
        "utf8",
      );
      const result = await tools().write.run(
        {
          path: "projects.json",
          content: '{"projects": [\n{"id": 1}]}\n',
        },
        ctx(),
      );
      expect(result.summary.split("\n")[0]).toBe(
        '⚠ replaced the user\'s file `projects.json` (2 lines → 2, header changed); the previous content is saved — `os.fs.restore {"path":"projects.json"}` brings it back',
      );
    });

    it("is loud on a shrink alone, without a header clause for a non-header format", async () => {
      const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
        "\n",
      );
      await writeFile(join(dir, "app.log"), before, "utf8");
      const result = await tools().write.run(
        { path: "app.log", content: "line 0\nline 1\n" },
        ctx(),
      );
      const note = result.summary.split("\n")[0] ?? "";
      expect(note.startsWith("⚠ replaced the user's file `app.log` (100 lines → 2); ")).toBe(true);
      expect(note).not.toContain("header changed");
    });

    it("keeps to a quiet one-liner for a same-size replacement", async () => {
      await writeFile(join(dir, "a.py"), "x = 1\ny = 2\nz = 3\n", "utf8");
      const result = await tools().write.run(
        { path: "a.py", content: "x = 10\ny = 20\nz = 30\n" },
        ctx(),
      );
      const note = result.summary.split("\n")[0];
      expect(note).toBe(
        "replaced the user's file `a.py` (3 lines → 3); previous content saved",
      );
      expect(note).not.toContain("⚠");
      expect(result.details.replaced).toMatchObject({
        shrunk: false,
        headerChanged: false,
        saved: "saved",
      });
      expect(existsSync(join(copiesDir(), "1-a.py"))).toBe(true);
    });

    it("says nothing about a file the agent created earlier this session, and still counts the lines", async () => {
      const t = tools();
      const first = await t.write.run(
        { path: "out/report.md", content: "# Report\n\nfirst\n" },
        ctx(),
      );
      expect(first.summary).toBe(
        `wrote 16 bytes to ${join(dir, "out", "report.md")} (replace, new file, 3 lines)`,
      );
      expect(first.details.existed).toBe(false);
      const second = await t.write.run(
        { path: "out/report.md", content: "# Done\n" },
        ctx(),
      );
      expect(second.summary).toBe(
        `wrote 7 bytes to ${join(dir, "out", "report.md")} (replace, 3 lines → 1)`,
      );
      expect(second.details.replaced).toBeUndefined();
      // No copy was taken: the working directory has no restore folder
      // at all, only the session's created-set record.
      expect(existsSync(copiesDir())).toBe(false);
      expect(await readdir(join(stateDir, "restore"))).toEqual(["sessions"]);
      expect(await readdir(join(stateDir, "restore", "sessions"))).toEqual([
        "s-guard.json",
      ]);
    });

    it("a file created by an append is the agent's too; an append never replaces", async () => {
      const t = tools();
      await t.write.run(
        { path: "notes.txt", content: "one\n", mode: "append" },
        ctx(),
      );
      await writeFile(join(dir, "user.txt"), "a\nb\nc\n", "utf8");
      const appended = await t.write.run(
        { path: "user.txt", content: "d\n", mode: "append" },
        ctx(),
      );
      expect(appended.summary).toContain("(append)");
      expect(appended.details.replaced).toBeUndefined();
      const replaced = await t.write.run(
        { path: "notes.txt", content: "" },
        ctx(),
      );
      expect(replaced.details.replaced).toBeUndefined();
    });

    it("remembers the created set across a resumed session (same id, new process)", async () => {
      await tools().write.run(
        { path: "fresh.log", content: csv(5) },
        ctx("s-resumed"),
      );
      const resumed = tools(new FileRestoreStore(join(stateDir, "restore")));
      const result = await resumed.write.run(
        { path: "fresh.log", content: "x\n" },
        ctx("s-resumed"),
      );
      expect(result.details.replaced).toBeUndefined();
      // A different session does not inherit it: the file is the user's there.
      const other = await resumed.write.run(
        { path: "fresh.log", content: "y\n" },
        ctx("s-other"),
      );
      expect(other.summary.split("\n")[0]).toBe(
        "replaced the user's file `fresh.log` (1 line → 1); previous content saved",
      );
    });

    it("has nothing to say about an empty file, or when no store is wired", async () => {
      await writeFile(join(dir, "empty.csv"), "", "utf8");
      const empty = await tools().write.run(
        { path: "empty.csv", content: csv(3) },
        ctx(),
      );
      expect(empty.details.replaced).toBeUndefined();
      expect(empty.summary).toContain("(replace, 0 lines → 4)");

      await writeFile(join(dir, "sales.csv"), csv(50), "utf8");
      const bare = await tools(null).write.run(
        { path: "sales.csv", content: csv(1, "a,b") },
        ctx(),
      );
      expect(bare.details.replaced).toBeUndefined();
      expect(bare.summary).toBe(
        `wrote ${csv(1, "a,b").length} bytes to ${join(dir, "sales.csv")} (replace, 51 lines → 2)`,
      );
    });

    it("announces a file over the size cap loudly without reading or saving it", async () => {
      const big = Buffer.alloc(RESTORE_MAX_BYTES + 1, 0x61);
      await writeFile(join(dir, "huge.bin"), big);
      const result = await tools().write.run(
        { path: "huge.bin", content: "tiny\n" },
        ctx(),
      );
      expect(result.summary.split("\n")[0]).toBe(
        "⚠ replaced the user's file `huge.bin` (5.0 MB → 1 line); the previous content was too large to save (over 5.0 MB)",
      );
      expect(result.details.replaced).toMatchObject({
        saved: "too_large",
        linesBefore: null,
      });
      expect(result.summary).toContain("(replace, 5.0 MB → 1 line)");
      expect(await store.listCopies(dir)).toEqual([]);
    });

    it("spells the operator's retarget in the note when the write was moved", async () => {
      await writeFile(join(dir, "moved.txt"), "a\nb\nc\nd\ne\n", "utf8");
      const moving = new ApprovalGate({
        emit: (req) =>
          moving.resolve({
            approvalId: req.approvalId,
            approved: true,
            pathOverride: join(dir, "moved.txt"),
          }),
      });
      const write = buildOsFsWriteTool({
        approvals: moving,
        approvalRequired: true,
        restore: store,
      });
      const result = await write.run(
        { path: "elsewhere.txt", content: "z\n" },
        ctx(),
      );
      expect(result.summary.split("\n")[0]).toBe(
        `⚠ replaced the user's file \`${join(dir, "moved.txt")}\` (5 lines → 1, header changed); the previous content is saved — \`os.fs.restore ${JSON.stringify({ path: join(dir, "moved.txt") })}\` brings it back`,
      );
    });
  });

  describe("os.fs.restore", () => {
    it("brings the saved bytes back, approval-gated like a write, and names what came back", async () => {
      const before = csv(2401);
      await writeFile(join(dir, "sales.csv"), before, "utf8");
      const t = tools();
      await t.write.run({ path: "sales.csv", content: csv(9, "sku,qty") }, ctx());
      prompts.length = 0;

      const result = await t.restore.run({ path: "sales.csv" }, ctx());
      expect(result.status).toBe("ok");
      expect(result.summary).toBe(
        `restored \`sales.csv\` from the copy saved before os.fs.write: ${(before.length / 1024).toFixed(1)} KB, 2,402 lines`,
      );
      expect(result.details).toMatchObject({
        path: join(dir, "sales.csv"),
        bytes: before.length,
        lines: 2402,
        savedBefore: "os.fs.write",
        savedBy: "s-guard",
        copy: "1-sales.csv",
      });
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        tool: "os.fs.restore",
        category: "fs_write_workspace",
      });
      expect(prompts[0]?.reason).toContain("2,402 lines");
      // The copy stays: a second restore still works.
      await t.write.run({ path: "sales.csv", content: "gone\n" }, ctx());
      const again = await t.restore.run({ path: "sales.csv" }, ctx());
      expect(again.status).toBe("ok");
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);
    });

    it("restores the most recent copy of a path replaced twice", async () => {
      await writeFile(join(dir, "a.txt"), "first\n", "utf8");
      const t = tools();
      await t.write.run({ path: "a.txt", content: "second\n" }, ctx());
      await t.write.run({ path: "a.txt", content: "third\n" }, ctx());
      await t.restore.run({ path: "a.txt" }, ctx());
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("second\n");
    });

    it("refuses when nothing was saved for the path, and when no store is wired", async () => {
      await expect(
        tools().restore.run({ path: "never.csv" }, ctx()),
      ).rejects.toThrow(/nothing saved for `never.csv` in this working directory/);
      await expect(
        tools(null).restore.run({ path: "never.csv" }, ctx()),
      ).rejects.toThrow(/keeps no restore copies/);
      await expect(tools().restore.run({}, ctx())).rejects.toThrow(
        /`path` must be a non-empty string/,
      );
    });

    it("is a registered, approval-gated os.fs tool", async () => {
      const registry = new ToolRegistry();
      registerOsTools(registry, {
        approvals: gate,
        approvalRequired: true,
        config: {
          tools: {
            shell: { defaultTimeoutMs: 600_000, jobMaxMs: 3_600_000, maxJobs: 3 },
          },
          http: {
            enabled: true,
            approvalMode: "writes",
            hostAllowlist: null,
            maxResponseBytes: 1_048_576,
            defaultTimeoutMs: 30_000,
          },
          web: {
            search: {
              enabled: true,
              provider: "duckduckgo",
              maxResults: 8,
              timeoutMs: 15_000,
              cacheTtlMinutes: 15,
              fallback: [],
              searxng: { instanceUrl: null },
              exa: {
                endpoint: "https://mcp.exa.ai/mcp",
                apiEndpoint: "https://api.exa.ai/search",
                apiKeyEnv: "EXA_API_KEY",
              },
              brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
            },
          },
          projects: { roots: [] },
        },
        listRecentSessionDirs: () => [],
        stateDir,
      });
      expect(registry.has("os.fs.restore")).toBe(true);
      expect(registry.get("os.fs.restore").readonly).toBe(false);
      // The store the registry wired lives under `<stateDir>/restore`.
      await writeFile(join(dir, "user.csv"), csv(20), "utf8");
      await registry
        .get("os.fs.write")
        .run({ path: "user.csv", content: csv(1, "q") }, ctx("s-reg"));
      expect(existsSync(join(copiesDir(), "1-user.csv"))).toBe(true);
    });
  });

  describe("copies are shared per working directory (F43)", () => {
    // Live, fusion, 2026-09-15: worker A (its own ephemeral session)
    // overwrote the user's 2,401-row `sales.csv` with a 9-row sample;
    // the copy went under A's session, and worker B — a different
    // session — sent to restore it found nothing.
    it("lets another session on the same working directory restore what one session replaced", async () => {
      const before = csv(2401);
      await writeFile(join(dir, "sales.csv"), before, "utf8");
      const t = tools();
      const replaced = await t.write.run(
        { path: "sales.csv", content: csv(9, "sku,qty") },
        ctx("s-fw-worker-a"),
      );
      expect(replaced.summary).toContain("⚠ replaced the user's file `sales.csv`");

      // Worker B of a later fan-out, and the orchestrator itself.
      const byB = await t.restore.run({ path: "sales.csv" }, ctx("s-fw-worker-b"));
      expect(byB.status).toBe("ok");
      expect(byB.details).toMatchObject({ savedBy: "s-fw-worker-a", copy: "1-sales.csv" });
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);

      await t.write.run({ path: "sales.csv", content: "gone\n" }, ctx("s-fw-worker-c"));
      await t.restore.run({ path: "sales.csv" }, ctx("s-orchestrator"));
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);

      // A new process (a fresh store over the same state dir) sees it too.
      await t.write.run({ path: "sales.csv", content: "gone again\n" }, ctx("s-fw-worker-d"));
      const later = tools(new FileRestoreStore(join(stateDir, "restore")));
      await later.restore.run({ path: "sales.csv" }, ctx("s-resumed"));
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);
    });

    it("keeps working directories apart: a copy taken in one is not visible from another", async () => {
      const other = await mkdtemp(join(tmpdir(), "atomic-replace-guard-other-"));
      try {
        await writeFile(join(dir, "sales.csv"), csv(100), "utf8");
        await writeFile(join(other, "sales.csv"), csv(50, "x,y"), "utf8");
        const t = tools();
        await t.write.run({ path: "sales.csv", content: csv(1) }, ctx());
        expect(restoreKey(other)).not.toBe(restoreKey(dir));
        expect(existsSync(join(stateDir, "restore", restoreKey(other)))).toBe(false);

        const otherCtx: ToolContext = { ...ctx(), workingDir: other };
        await expect(
          t.restore.run({ path: "sales.csv" }, otherCtx),
        ).rejects.toThrow(/nothing saved for `sales.csv` in this working directory/);
        expect(await readFile(join(other, "sales.csv"), "utf8")).toBe(csv(50, "x,y"));

        // The other directory gets its own folder once something is replaced there.
        await t.write.run({ path: "sales.csv", content: "z\n" }, otherCtx);
        expect(await store.listCopies(other)).toMatchObject([{ n: 1, path: join(other, "sales.csv") }]);
        expect(await store.listCopies(dir)).toMatchObject([{ n: 1, path: join(dir, "sales.csv") }]);
        await t.restore.run({ path: "sales.csv" }, otherCtx);
        expect(await readFile(join(other, "sales.csv"), "utf8")).toBe(csv(50, "x,y"));
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });

    it("keys on the absolute working directory, however it was spelled", () => {
      expect(restoreKey(dir)).toMatch(/^[0-9a-f]{32}$/);
      expect(restoreKey(`${dir}/`)).toBe(restoreKey(dir));
      expect(restoreKey(join(dir, "sub", ".."))).toBe(restoreKey(dir));
      expect(restoreKey(join(dir, "sub"))).not.toBe(restoreKey(dir));
    });

    it("gives concurrent replacements by several sessions distinct copies (a fan-out shares one manifest)", async () => {
      const t = tools();
      const names = ["a.csv", "b.csv", "c.csv", "d.csv", "e.csv"];
      for (const name of names) {
        await writeFile(join(dir, name), `user ${name}\n1\n2\n3\n4\n`, "utf8");
      }
      await Promise.all(
        names.map((name, i) =>
          t.write.run({ path: name, content: `agent ${name}\n` }, ctx(`s-fw-${i}`)),
        ),
      );
      const copies = await store.listCopies(dir);
      expect(copies.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(copies.map((c) => c.file)).size).toBe(5);
      expect(new Set(copies.map((c) => c.sessionId)).size).toBe(5);
      for (const name of names) {
        await t.restore.run({ path: name }, ctx("s-later"));
        expect(await readFile(join(dir, name), "utf8")).toBe(`user ${name}\n1\n2\n3\n4\n`);
      }
    });

    it("the created set stays per session: a file one worker created is the user's to another", async () => {
      const t = tools();
      await t.write.run({ path: "out.csv", content: csv(10) }, ctx("s-fw-a"));
      const sameSession = await t.write.run({ path: "out.csv", content: csv(1) }, ctx("s-fw-a"));
      expect(sameSession.details.replaced).toBeUndefined();
      const otherSession = await t.write.run({ path: "out.csv", content: "x\n" }, ctx("s-fw-b"));
      expect(otherSession.summary.split("\n")[0]).toBe(
        '⚠ replaced the user\'s file `out.csv` (2 lines → 1, header changed); the previous content is saved — `os.fs.restore {"path":"out.csv"}` brings it back',
      );
      expect(await store.wasCreated("s-fw-a", join(dir, "out.csv"))).toBe(true);
      expect(await store.wasCreated("s-fw-b", join(dir, "out.csv"))).toBe(false);
    });
  });

  describe("copy cap", () => {
    it(`keeps the last ${RESTORE_COPY_CAP} copies per working directory, dropping the oldest file`, async () => {
      const t = tools();
      for (let i = 1; i <= RESTORE_COPY_CAP + 1; i++) {
        await writeFile(join(dir, `f${i}.txt`), `user ${i}\n`, "utf8");
        await t.write.run({ path: `f${i}.txt`, content: `agent ${i}\n` }, ctx());
      }
      const copies = await store.listCopies(dir);
      expect(copies).toHaveLength(RESTORE_COPY_CAP);
      expect(copies[0]?.n).toBe(2);
      expect(copies.at(-1)?.n).toBe(RESTORE_COPY_CAP + 1);
      const files = (await readdir(copiesDir())).sort();
      expect(files).not.toContain("1-f1.txt");
      expect(files).toContain("2-f2.txt");
      expect(files).toContain(`${RESTORE_COPY_CAP + 1}-f${RESTORE_COPY_CAP + 1}.txt`);
      await expect(
        t.restore.run({ path: "f1.txt" }, ctx()),
      ).rejects.toThrow(/nothing saved/);
      await t.restore.run({ path: "f2.txt" }, ctx());
      expect(await readFile(join(dir, "f2.txt"), "utf8")).toBe("user 2\n");
    });
  });

  describe("os.fs.edit and os.fs.patch", () => {
    it("edit: a replaceAll that cut the file by 80 % is announced and saved; a small edit is not", async () => {
      const before = csv(100);
      await writeFile(join(dir, "sales.csv"), before, "utf8");
      const t = tools();
      const small = await t.edit.run(
        { path: "sales.csv", oldString: "row 1,", newString: "row one," },
        ctx(),
      );
      expect(small.details.replaced).toBeUndefined();
      expect(small.summary.startsWith("--- a/")).toBe(true);

      // Every data row shares ",row " — replacing the whole tail of each
      // line with nothing leaves the header and 100 empty lines... so
      // make it a true shrink: collapse the newlines instead.
      const shrink = await t.edit.run(
        { path: "sales.csv", oldString: "\n", newString: " ", replaceAll: true },
        ctx(),
      );
      const note = shrink.summary.split("\n")[0];
      expect(note).toBe(
        '⚠ shrank the user\'s file `sales.csv` (101 lines → 1); the previous content is saved — `os.fs.restore {"path":"sales.csv"}` brings it back',
      );
      expect(shrink.details.replaced).toMatchObject({
        linesBefore: 101,
        linesAfter: 1,
        shrunk: true,
        saved: "saved",
        copy: "1-sales.csv",
      });
      await t.restore.run({ path: "sales.csv" }, ctx());
      expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(
        before.replace("row 1,", "row one,"),
      );
    });

    it("edit: a file the agent created is never announced, however much it shrinks", async () => {
      const t = tools();
      await t.write.run({ path: "mine.txt", content: csv(50) }, ctx());
      const result = await t.edit.run(
        { path: "mine.txt", oldString: "\n", newString: "", replaceAll: true },
        ctx(),
      );
      expect(result.details.replaced).toBeUndefined();
    });

    it("patch: a hunk that deletes most of a user's file is announced with the absolute path; a created file is the agent's", async () => {
      const before = csv(40);
      const after = csv(2);
      await writeFile(join(dir, "data.csv"), before, "utf8");
      const t = tools();
      const shrink = await t.patch.run(
        { patch: createPatch("data.csv", before, after), apply: true },
        ctx(),
      );
      expect(shrink.status).toBe("ok");
      expect(shrink.summary.split("\n")[0]).toBe(
        `⚠ shrank the user's file \`${join(dir, "data.csv")}\` (41 lines → 3); the previous content is saved — \`os.fs.restore ${JSON.stringify({ path: join(dir, "data.csv") })}\` brings it back`,
      );
      expect(shrink.summary).toContain("patch applied:");
      expect(await readFile(join(dir, "data.csv"), "utf8")).toBe(after);
      await t.restore.run({ path: join(dir, "data.csv") }, ctx());
      expect(await readFile(join(dir, "data.csv"), "utf8")).toBe(before);

      const created = await t.patch.run(
        { patch: createPatch("new.csv", "", csv(30)), apply: true },
        ctx(),
      );
      expect(created.status).toBe("ok");
      expect(created.details.replaced).toBeUndefined();
      expect(await store.wasCreated("s-guard", join(dir, "new.csv"))).toBe(
        true,
      );
      const overwritten = await t.write.run(
        { path: "new.csv", content: "q\n" },
        ctx(),
      );
      expect(overwritten.details.replaced).toBeUndefined();
    });

    it("patch: a small change to a user's file is silent", async () => {
      const before = csv(40);
      const after = before.replace("row 2,", "row two,");
      await writeFile(join(dir, "data.csv"), before, "utf8");
      const result = await tools().patch.run(
        { patch: createPatch("data.csv", before, after), apply: true },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.details.replaced).toBeUndefined();
      expect(result.summary.startsWith("patch applied:")).toBe(true);
    });
  });

  describe("rules", () => {
    it("counts lines the way an editor does", () => {
      expect(countLines("")).toBe(0);
      expect(countLines("a")).toBe(1);
      expect(countLines("a\n")).toBe(1);
      expect(countLines("a\nb")).toBe(2);
      expect(countLines("a\r\nb\r\n")).toBe(2);
      expect(firstLine("h1,h2\r\n1,2\n")).toBe("h1,h2");
      expect(firstLine("solo")).toBe("solo");
    });

    it("a shrink is 80 % or more of the lines gone, never on an empty file", () => {
      expect(isShrink(2401, 10)).toBe(true);
      expect(isShrink(10, 2)).toBe(true);
      expect(isShrink(10, 3)).toBe(false);
      expect(isShrink(5, 1)).toBe(true);
      expect(isShrink(4, 1)).toBe(false);
      expect(isShrink(1, 0)).toBe(true);
      expect(isShrink(0, 0)).toBe(false);
      expect(isShrink(0, 5)).toBe(false);
    });
  });
});
