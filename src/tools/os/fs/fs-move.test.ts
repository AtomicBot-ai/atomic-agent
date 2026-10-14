import * as fsPromises from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsMoveTool } from "./fs-move.js";
import type { MoveFs } from "./fs-move-plan.js";
import { buildOsFsRestoreTool } from "./fs-restore.js";
import { FileRestoreStore } from "./fs-restore-store.js";

let dir: string;
let state: string;
let gate: ApprovalGate;
let prompts: ApprovalRequest[];
let answers: Omit<ApprovalDecision, "approvalId">[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-move-"));
  state = await mkdtemp(join(tmpdir(), "fs-move-state-"));
  prompts = [];
  answers = [];
  gate = new ApprovalGate({
    level: 1,
    emit: (request) => {
      prompts.push(request);
      const answer = answers.shift() ?? { approved: true };
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, ...answer }));
    },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workingDir: dir,
  sessionId: "s-move",
  stepIndex: 0,
  signal: new AbortController().signal,
});

function tool(extra: { fs?: MoveFs; restore?: FileRestoreStore; trust?: string[]; declared?: string[] } = {}) {
  return buildOsFsMoveTool(
    {
      approvals: gate,
      approvalRequired: true,
      ...(extra.restore ? { restore: extra.restore } : {}),
      ...(extra.trust ? { trustConfigPaths: extra.trust } : {}),
      ...(extra.declared
        ? { declaredInputs: { inputsOf: () => extra.declared ?? [] } }
        : {}),
    },
    extra.fs ? { fs: extra.fs } : {},
  );
}

async function put(rel: string, content = rel): Promise<string> {
  const path = join(dir, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("os.fs.move", () => {
  it("renames a file in place, with a rename card and the undo call in the result", async () => {
    await put("draft.txt", "hello");
    const result = await tool().run({ from: "draft.txt", to: "final.txt" }, ctx());
    expect(result.status).toBe("ok");
    expect(existsSync(join(dir, "draft.txt"))).toBe(false);
    expect(await readFile(join(dir, "final.txt"), "utf8")).toBe("hello");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.tool).toBe("os.fs.move");
    expect(prompts[0]!.category).toBe("fs_write_workspace");
    expect(prompts[0]!.reason).toBe(`rename draft.txt to final.txt in ${dir}`);
    expect(result.summary).toContain(`To undo: os.fs.move ${JSON.stringify({ from: join(dir, "final.txt"), to: join(dir, "draft.txt") })}`);
  });

  it("sorts many files into folders that do not exist yet, under one approval", async () => {
    await put("a.pdf");
    await put("b.pdf");
    await put("c.jpg");
    const result = await tool().run(
      {
        moves: [
          { from: "a.pdf", to: "Sorted/Docs/" },
          { from: "b.pdf", to: "Sorted/Docs/b-renamed.pdf" },
          { from: "c.jpg", to: "Sorted/Images/" },
        ],
      },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.reason).toBe("move 3 items to 2 folders");
    expect(prompts[0]!.preview).toContain(`${join(dir, "a.pdf")} → ${join(dir, "Sorted/Docs/a.pdf")}`);
    expect(existsSync(join(dir, "Sorted/Docs/a.pdf"))).toBe(true);
    expect(existsSync(join(dir, "Sorted/Docs/b-renamed.pdf"))).toBe(true);
    expect(existsSync(join(dir, "Sorted/Images/c.jpg"))).toBe(true);
    expect(result.details.undo).toEqual({
      moves: [
        { from: join(dir, "Sorted/Images/c.jpg"), to: join(dir, "c.jpg") },
        { from: join(dir, "Sorted/Docs/b-renamed.pdf"), to: join(dir, "b.pdf") },
        { from: join(dir, "Sorted/Docs/a.pdf"), to: join(dir, "a.pdf") },
      ],
    });
    // The undo list is itself a valid call that puts everything back.
    const undo = await tool().run(result.details.undo as Record<string, unknown>, ctx());
    expect(undo.status).toBe("ok");
    expect(await readFile(join(dir, "b.pdf"), "utf8")).toBe("b.pdf");
  });

  it("moves into an existing folder named without a trailing slash, and handles spaces in paths", async () => {
    await put("My Files/Q1 report (final).pdf", "q1");
    await mkdir(join(dir, "Archive 2026"));
    const result = await tool().run(
      { from: "My Files/Q1 report (final).pdf", to: "Archive 2026" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "Archive 2026/Q1 report (final).pdf"), "utf8")).toBe("q1");
    expect(prompts[0]!.reason).toBe(
      `move ${join(dir, "My Files/Q1 report (final).pdf")} to ${join(dir, "Archive 2026/Q1 report (final).pdf")}`,
    );
  });

  it("refuses to replace an existing file without overwrite, before asking anyone", async () => {
    await put("a.txt", "new");
    await put("b.txt", "keep me");
    await expect(tool().run({ from: "a.txt", to: "b.txt" }, ctx())).rejects.toThrow(
      "already exists — pass overwrite: true only if the user wants it replaced",
    );
    expect(prompts).toHaveLength(0);
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });

  it("with overwrite replaces the file and keeps its old content for os.fs.restore", async () => {
    const restore = new FileRestoreStore(join(state, "restore"));
    await put("a.txt", "new");
    await put("b.txt", "old");
    const result = await tool({ restore }).run({ from: "a.txt", to: "b.txt", overwrite: true }, ctx());
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("new");
    expect(prompts[0]!.reason).toContain(", replacing 1 existing file");
    expect(prompts[0]!.targetPaths).toEqual([join(dir, "a.txt"), join(dir, "b.txt")]);
    expect(result.fullOutput).toContain("its previous content is saved");
    const back = await buildOsFsRestoreTool({ approvals: gate, approvalRequired: true, restore })
      .run({ path: join(dir, "b.txt") }, ctx());
    expect(back.status).toBe("ok");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("old");
  });

  it("never replaces a folder, even with overwrite", async () => {
    await put("a.txt");
    await put("taken/x.txt");
    await expect(
      tool().run({ from: "a.txt", to: join(dir, "taken"), overwrite: true }, ctx()),
    ).resolves.toMatchObject({ status: "ok" });
    expect(existsSync(join(dir, "taken/a.txt"))).toBe(true);
    await put("taken/sub/keep.txt");
    await put("sub/y.txt");
    await expect(
      tool().run({ from: "sub", to: "taken/", overwrite: true }, ctx()),
    ).rejects.toThrow("is not a file; it is never replaced");
  });

  it("falls back to copy-and-remove when the destination is on another volume", async () => {
    await put("photos/2026/a.jpg", "jpeg");
    const exdev: MoveFs = {
      ...fsPromises,
      // The source is on another volume; the temporary copy beside the
      // destination renames into place as usual.
      rename: async (from, to) => {
        if (String(from) === join(dir, "photos")) {
          throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        }
        return fsPromises.rename(from, to);
      },
    };
    const result = await tool({ fs: exdev }).run({ from: "photos", to: "External/" }, ctx());
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "External/photos/2026/a.jpg"), "utf8")).toBe("jpeg");
    expect(existsSync(join(dir, "photos"))).toBe(false);
    expect(await fsPromises.readdir(join(dir, "External"))).toEqual(["photos"]);
    expect(result.details.moves).toEqual([
      { from: join(dir, "photos"), to: join(dir, "External/photos"), method: "copy" },
    ]);
  });

  it("refuses to move a folder into itself", async () => {
    await put("project/src/a.ts");
    await expect(tool().run({ from: "project", to: "project/backup/" }, ctx())).rejects.toThrow(
      "cannot move the folder `project` into itself",
    );
    expect(prompts).toHaveLength(0);
  });

  it("refuses a batch whose outcome would depend on its order", async () => {
    await put("x/a.txt");
    await put("y.txt");
    await expect(
      tool().run({ moves: [{ from: "x", to: "z" }, { from: "x/a.txt", to: "w.txt" }] }, ctx()),
    ).rejects.toThrow("is inside `x`, which this call also moves");
    await expect(
      tool().run({ moves: [{ from: "y.txt", to: "out/" }, { from: "x/a.txt", to: "out/y.txt" }] }, ctx()),
    ).rejects.toThrow("would both land at");
    expect(prompts).toHaveLength(0);
  });

  it("stops at the first failure and says what moved and how to undo it", async () => {
    await put("one.txt");
    await put("two.txt");
    let calls = 0;
    const flaky: MoveFs = {
      ...fsPromises,
      rename: async (from, to) => {
        if (++calls === 2) throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
        return fsPromises.rename(from, to);
      },
    };
    const result = await tool({ fs: flaky }).run(
      { moves: [{ from: "one.txt", to: "done/" }, { from: "two.txt", to: "done/" }] },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.fullOutput).toContain("moved 1 of 2, then stopped at `two.txt`");
    expect(result.summary.trimEnd().endsWith("To undo: os.fs.move " + JSON.stringify({ from: join(dir, "done/one.txt"), to: join(dir, "one.txt") }))).toBe(true);
    expect(existsSync(join(dir, "done/one.txt"))).toBe(true);
    expect(existsSync(join(dir, "two.txt"))).toBe(true);
    expect(result.details.undo).toEqual({ moves: [{ from: join(dir, "done/one.txt"), to: join(dir, "one.txt") }] });
  });

  it("moves nothing when the user declines", async () => {
    await put("a.txt");
    answers.push({ approved: false });
    await expect(tool().run({ from: "a.txt", to: "b/" }, ctx())).rejects.toMatchObject({ byUser: true });
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(existsSync(join(dir, "b"))).toBe(false);
  });

  it("classifies by both ends: the agent's own config on either side is trust_config", async () => {
    const config = await put("config.json", "{}");
    await tool({ trust: [config] }).run({ from: "config.json", to: "old/" }, ctx());
    expect(prompts[0]!.category).toBe("trust_config");
  });

  it("treats moving the folder that holds the agent's config as a trust_config change", async () => {
    const config = await put("state/config.json", "{}");
    await put("state/.env", "KEY=1");
    await tool({ trust: [config] }).run({ from: "state", to: "old/" }, ctx());
    expect(prompts[0]!.category).toBe("trust_config");
  });

  it("normalises an absolute path, so the undo puts a folder back where it was", async () => {
    await put("Photos/a.jpg");
    const result = await tool().run({ from: `${join(dir, "Photos")}/`, to: "Archive/" }, ctx());
    expect(result.details.undo).toEqual({
      moves: [{ from: join(dir, "Archive/Photos"), to: join(dir, "Photos") }],
    });
  });

  it("refuses a batch that names one new folder both with and without the slash", async () => {
    await put("a.pdf");
    await put("b.pdf");
    await expect(
      tool().run({ moves: [{ from: "a.pdf", to: "Docs/" }, { from: "b.pdf", to: "Docs" }] }, ctx()),
    ).rejects.toThrow("end `to` with / to move an item INTO a folder");
    expect(prompts).toHaveLength(0);
  });

  it("does not take a hard link for the destination's own spelling", async () => {
    await put("a.txt", "same");
    await fsPromises.link(join(dir, "a.txt"), join(dir, "b.txt"));
    await expect(tool().run({ from: "a.txt", to: "b.txt" }, ctx())).rejects.toThrow("already exists");
  });

  it("refuses to move or overwrite a worker's declared input", async () => {
    const input = await put("data/sales.csv");
    await expect(
      tool({ declared: [input] }).run({ from: "data", to: "elsewhere/" }, ctx()),
    ).rejects.toThrow("is an input of this task");
    expect(prompts).toHaveLength(0);
  });

  it("reports a missing source without asking", async () => {
    await expect(tool().run({ from: "nope.txt", to: "x/" }, ctx())).rejects.toThrow(
      "os.fs.move: nothing at `nope.txt`",
    );
    expect(prompts).toHaveLength(0);
  });
});
