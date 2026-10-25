import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { osFsReadTool } from "./fs-read.js";
import {
  FileReadVersions,
  MAX_TRACKED_FILE_VERSIONS,
  STALE_READ_NOTICE,
  changedSinceRead,
  recordOwnWrite,
} from "./fs-read-freshness.js";
import { buildOsFsWriteTool } from "./fs-write.js";

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

const toolOptions = () => ({ approvals: approveAll(), approvalRequired: true });

describe("fs-read-freshness (ATO-659)", () => {
  let dir: string;
  let fileVersions: FileReadVersions;
  let ctx: ToolContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-freshness-"));
    fileVersions = new FileReadVersions();
    ctx = {
      workingDir: dir,
      sessionId: "test-session",
      stepIndex: 0,
      signal: new AbortController().signal,
      fileVersions,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = (path: string, extra: Record<string, unknown> = {}) =>
    osFsReadTool.run({ path, ...extra }, ctx);

  describe("changedSinceRead", () => {
    it("is false for a file that was never read", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "one\n", "utf8");
      expect(await changedSinceRead(fileVersions, file)).toBe(false);
    });

    it("is false without a store", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "one\n", "utf8");
      expect(await changedSinceRead(undefined, file)).toBe(false);
    });

    it("is false when the file still holds what was read", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "one\ntwo\n", "utf8");
      await read("a.txt", { offset: 2, limit: 1 });
      expect(await changedSinceRead(fileVersions, file)).toBe(false);
    });

    it("catches a same-size in-place change", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "abc\n", "utf8");
      await read("a.txt");
      await writeFile(file, "xyz\n", "utf8");
      expect(await changedSinceRead(fileVersions, file)).toBe(true);
    });

    it("catches a change in size, even past a byte-capped read", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "head\ntail\n", "utf8");
      await read("a.txt", { maxBytes: 4 });
      await writeFile(file, "head\ntail, longer now\n", "utf8");
      expect(await changedSinceRead(fileVersions, file)).toBe(true);
    });

    it("counts a deleted file as changed", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "one\n", "utf8");
      await read("a.txt");
      await unlink(file);
      expect(await changedSinceRead(fileVersions, file)).toBe(true);
    });

    it("is cleared by our own write", async () => {
      const file = join(dir, "a.txt");
      await writeFile(file, "one\n", "utf8");
      await read("a.txt");
      await writeFile(file, "two, longer\n", "utf8");
      await recordOwnWrite(fileVersions, file);
      expect(await changedSinceRead(fileVersions, file)).toBe(false);
    });
  });

  it("remembers a bounded number of files", () => {
    const store = new FileReadVersions();
    for (let i = 0; i <= MAX_TRACKED_FILE_VERSIONS; i++) {
      store.record(`/f${i}`, { size: 1, hashedBytes: 1, contentHash: "h" });
    }
    expect(store.get("/f0")).toBeUndefined();
    expect(store.get(`/f${MAX_TRACKED_FILE_VERSIONS}`)).toBeDefined();
  });

  describe("os.fs.edit", () => {
    it("adds the notice when the file changed since the read, and still edits", async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "const x = 1;\nconst y = 2;\n", "utf8");
      await read("a.ts");
      // Someone else saves the file between the read and the edit.
      await writeFile(file, "const x = 1;\nconst y = 3;\n", "utf8");
      const result = await buildOsFsEditTool(toolOptions()).run(
        { path: "a.ts", oldString: "const x = 1;", newString: "const x = 9;" },
        ctx,
      );
      expect(result.status).toBe("ok");
      expect(result.summary.startsWith(STALE_READ_NOTICE)).toBe(true);
      expect(result.details.changedSinceRead).toBe(true);
      expect(await readFile(file, "utf8")).toBe("const x = 9;\nconst y = 3;\n");
    });

    it("stays silent after the agent's own edits", async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "const x = 1;\nconst y = 2;\n", "utf8");
      await read("a.ts");
      const edit = buildOsFsEditTool(toolOptions());
      const first = await edit.run(
        { path: "a.ts", oldString: "const x = 1;", newString: "const x = 10;" },
        ctx,
      );
      const second = await edit.run(
        { path: "a.ts", oldString: "const y = 2;", newString: "const y = 20;" },
        ctx,
      );
      expect(first.summary).not.toContain(STALE_READ_NOTICE);
      expect(second.summary).not.toContain(STALE_READ_NOTICE);
      expect(second.details.changedSinceRead).toBeUndefined();
    });

    it("says why when oldString no longer matches a changed file", async () => {
      const file = join(dir, "a.ts");
      await writeFile(file, "const x = 1;\n", "utf8");
      await read("a.ts");
      await writeFile(file, "let renamed = 1;\n", "utf8");
      await expect(
        buildOsFsEditTool(toolOptions()).run(
          { path: "a.ts", oldString: "const x = 1;", newString: "const x = 2;" },
          ctx,
        ),
      ).rejects.toThrow(STALE_READ_NOTICE);
    });

    it("stays silent on a file that was never read", async () => {
      await writeFile(join(dir, "a.ts"), "const x = 1;\n", "utf8");
      const result = await buildOsFsEditTool(toolOptions()).run(
        { path: "a.ts", oldString: "const x = 1;", newString: "const x = 2;" },
        ctx,
      );
      expect(result.summary).not.toContain(STALE_READ_NOTICE);
    });
  });

  describe("os.fs.write", () => {
    it("adds the notice to a replace of a file that changed since the read", async () => {
      const file = join(dir, "notes.md");
      await writeFile(file, "draft\n", "utf8");
      await read("notes.md");
      await writeFile(file, "draft plus the user's new line\n", "utf8");
      const result = await buildOsFsWriteTool(toolOptions()).run(
        { path: "notes.md", content: "rewritten\n" },
        ctx,
      );
      expect(result.status).toBe("ok");
      expect(result.summary.startsWith(STALE_READ_NOTICE)).toBe(true);
      expect(await readFile(file, "utf8")).toBe("rewritten\n");
    });

    it("does not add it to an append, and a write after our write is silent", async () => {
      const file = join(dir, "log.txt");
      await writeFile(file, "a\n", "utf8");
      await read("log.txt");
      await writeFile(file, "a\nb\n", "utf8");
      const write = buildOsFsWriteTool(toolOptions());
      const appended = await write.run(
        { path: "log.txt", content: "c\n", mode: "append" },
        ctx,
      );
      expect(appended.summary).not.toContain(STALE_READ_NOTICE);
      const replaced = await write.run(
        { path: "log.txt", content: "fresh\n" },
        ctx,
      );
      expect(replaced.summary).not.toContain(STALE_READ_NOTICE);
    });
  });

  describe("os.fs.patch", () => {
    it("names the file that changed since the read", async () => {
      const file = join(dir, "list.txt");
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const original = `${lines.join("\n")}\n`;
      await writeFile(file, original, "utf8");
      await read("list.txt");
      // The user edits a line far from the hunk; the patch still lands.
      const drifted = original.replace("line 20", "line twenty");
      await writeFile(file, drifted, "utf8");
      const patch = createPatch(
        "list.txt",
        original,
        original.replace("line 2\n", "line two\n"),
      );
      const result = await buildOsFsPatchTool(toolOptions()).run(
        { patch, apply: true },
        ctx,
      );
      expect(result.details.mode).toBe("applied");
      expect(result.summary.split("\n")[0]).toBe(
        `note: ${file} changed since you last read it; re-read it before editing it again.`,
      );
      expect(await readFile(file, "utf8")).toBe(
        drifted.replace("line 2\n", "line two\n"),
      );
    });

    it("stays silent when the file is as read", async () => {
      const file = join(dir, "s.txt");
      await writeFile(file, "alpha\nbeta\n", "utf8");
      await read("s.txt");
      const patch = createPatch("s.txt", "alpha\nbeta\n", "alpha\nBETA\n");
      const result = await buildOsFsPatchTool(toolOptions()).run(
        { patch, apply: true },
        ctx,
      );
      expect(result.details.mode).toBe("applied");
      expect(result.details.changedSinceRead).toBeUndefined();
    });
  });
});
