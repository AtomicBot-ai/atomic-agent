import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { computeDiffStat, splitLines, writeDiffStat } from "./fs-diffstat.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * ATO-1187: lines added/removed per changed file, for the desktop's
 * "Changed files" card. Carried in `details.diffstat` only, so what the
 * model reads does not change.
 */
describe("computeDiffStat", () => {
  it("is zero for identical text", () => {
    expect(computeDiffStat("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a one-line change as one removed and one added", () => {
    expect(computeDiffStat("a\nb\nc\n", "a\nB\nc\n")).toEqual({ added: 1, removed: 1 });
  });

  it("counts pure insertions and deletions", () => {
    expect(computeDiffStat("a\nc\n", "a\nb1\nb2\nc\n")).toEqual({ added: 2, removed: 0 });
    expect(computeDiffStat("a\nb\nc\nd\n", "a\nd\n")).toEqual({ added: 0, removed: 2 });
  });

  it("finds lines kept between scattered changes (replaceAll)", () => {
    const before = "x = 1\nkeep\nx = 1\nkeep\nx = 1\n";
    const after = "x = 2\nkeep\nx = 2\nkeep\nx = 2\n";
    expect(computeDiffStat(before, after)).toEqual({ added: 3, removed: 3 });
  });

  it("treats CRLF like LF and a trailing newline as the end of the last line", () => {
    expect(computeDiffStat("a\r\nb\r\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("counts a file emptied or filled from nothing", () => {
    expect(computeDiffStat("a\nb\n", "")).toEqual({ added: 0, removed: 2 });
    expect(computeDiffStat("", "a\nb\nc")).toEqual({ added: 3, removed: 0 });
  });
});

describe("writeDiffStat", () => {
  it("counts an append and a new file as added lines only", () => {
    expect(writeDiffStat({ mode: "append", existed: true, priorText: "x\n", content: "a\nb\n" })).toEqual({ added: 2, removed: 0 });
    expect(writeDiffStat({ mode: "replace", existed: false, priorText: null, content: "a\nb\nc\n" })).toEqual({ added: 3, removed: 0 });
  });

  it("diffs a replace against the prior text, and gives no count when it was too big to read", () => {
    expect(writeDiffStat({ mode: "replace", existed: true, priorText: "a\nb\n", content: "a\nc\n" })).toEqual({ added: 1, removed: 1 });
    expect(writeDiffStat({ mode: "replace", existed: true, priorText: null, content: "a\n" })).toBeNull();
  });
});

describe("os.fs.write / os.fs.edit carry details.diffstat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-linecount-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({
    workingDir: dir,
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  function approveAll(): ApprovalGate {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return gate;
  }

  it("a new file: every line added, and the summary does not mention it", async () => {
    const tool = buildOsFsWriteTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run({ path: "new.txt", content: "one\ntwo\nthree\n" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.diffstat).toEqual({ added: 3, removed: 0 });
    expect(result.summary).not.toMatch(/\badded\b|\bremoved\b|diffstat/);
  });

  it("a replace of an existing file: diffed against what was there", async () => {
    await writeFile(join(dir, "old.txt"), "a\nb\nc\n", "utf8");
    const tool = buildOsFsWriteTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run({ path: "old.txt", content: "a\nB\nc\nd\n" }, ctx());
    expect(result.details.diffstat).toEqual({ added: 2, removed: 1 });
  });

  it("an edit: the lines its replacement changed", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n", "utf8");
    const tool = buildOsFsEditTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run(
      { path: "a.ts", oldString: "const x = 1;", newString: "const x = 42;\nconst z = 3;" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.diffstat).toEqual({ added: 2, removed: 1 });
    expect(result.details.path).toBe(join(dir, "a.ts"));
  });
});
