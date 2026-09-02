import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult } from "../compressor/result-compressor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { osFsReadTool } from "../tools/os/fs-read.js";
import { READ_COVERAGE_DETAIL_KEY } from "../tools/os/fs-read-coverage.js";
import {
  classifyReadResult,
  describeCoverage,
  mergeRange,
  newlyCoveredCount,
  type LineRange,
} from "./read-coverage.js";
import {
  formatReadRepeatNotice,
  READ_REPEAT_WARNING_THRESHOLD,
  ToolLoopTracker,
} from "./loop-detector.js";
import {
  executeBatch,
  toBatchInputs,
  type BatchLoopSignal,
} from "./batch-executor.js";

// ---------------------------------------------------------------- algebra

describe("read coverage range algebra", () => {
  it("counts only lines outside the covered set", () => {
    const covered: LineRange[] = [{ start: 10, end: 20 }];
    expect(newlyCoveredCount(covered, { start: 12, end: 18 })).toBe(0);
    expect(newlyCoveredCount(covered, { start: 10, end: 20 })).toBe(0);
    expect(newlyCoveredCount(covered, { start: 15, end: 25 })).toBe(5);
    expect(newlyCoveredCount(covered, { start: 5, end: 12 })).toBe(5);
    expect(newlyCoveredCount(covered, { start: 30, end: 32 })).toBe(3);
  });

  it("merges adjacent ranges so pagination collapses to one interval", () => {
    let covered = mergeRange([], { start: 1, end: 40 });
    covered = mergeRange(covered, { start: 41, end: 80 });
    expect(covered).toEqual([{ start: 1, end: 80 }]);
    // The seam between two pages must not read as uncovered.
    expect(newlyCoveredCount(covered, { start: 38, end: 45 })).toBe(0);
  });

  it("keeps disjoint ranges separate and sorted", () => {
    let covered = mergeRange([], { start: 50, end: 60 });
    covered = mergeRange(covered, { start: 1, end: 10 });
    covered = mergeRange(covered, { start: 20, end: 30 });
    expect(covered).toEqual([
      { start: 1, end: 10 },
      { start: 20, end: 30 },
      { start: 50, end: 60 },
    ]);
    covered = mergeRange(covered, { start: 5, end: 55 });
    expect(covered).toEqual([{ start: 1, end: 60 }]);
  });

  it("describes coverage as line numbers only", () => {
    expect(describeCoverage([])).toBe("");
    expect(
      describeCoverage([
        { start: 1, end: 40 },
        { start: 88, end: 88 },
      ]),
    ).toBe("1-40, 88");
    const many: LineRange[] = Array.from({ length: 6 }, (_, i) => ({
      start: i * 10 + 1,
      end: i * 10 + 2,
    }));
    expect(describeCoverage(many)).toContain("… (2 more)");
  });
});

// ------------------------------------------------------------ observation

describe("classifyReadResult", () => {
  const detail = {
    path: "/tmp/a.ts",
    contentHash: "hash1",
    startLine: 3,
    endLine: 9,
    totalLines: 40,
  };

  it("extracts the observation from a successful read", () => {
    const result = compressToolResult({
      tool: "os.fs.read",
      status: "ok",
      output: "body",
      details: { [READ_COVERAGE_DETAIL_KEY]: detail },
    });
    expect(classifyReadResult("os.fs.read", result)).toEqual({
      path: "/tmp/a.ts",
      contentHash: "hash1",
      span: { start: 3, end: 9 },
      totalLines: 40,
    });
  });

  it("ignores other tools even when they carry a coverage detail", () => {
    const result = compressToolResult({
      tool: "os.fs.grep",
      status: "ok",
      output: "body",
      details: { [READ_COVERAGE_DETAIL_KEY]: detail },
    });
    expect(classifyReadResult("os.fs.grep", result)).toBeNull();
  });

  it("records nothing for a failed read", () => {
    const result = compressToolResult({
      tool: "os.fs.read",
      status: "error",
      output: "ENOENT",
      details: { errorName: "Error", [READ_COVERAGE_DETAIL_KEY]: detail },
    });
    expect(classifyReadResult("os.fs.read", result)).toBeNull();
  });

  it("maps an empty return to a null span", () => {
    const result = compressToolResult({
      tool: "os.fs.read",
      status: "ok",
      output: "",
      details: {
        [READ_COVERAGE_DETAIL_KEY]: { ...detail, startLine: 0, endLine: 0 },
      },
    });
    expect(classifyReadResult("os.fs.read", result)?.span).toBeNull();
  });
});

// ---------------------------------------------------------------- tracker

function observe(
  path: string,
  contentHash: string,
  span: LineRange | null,
  totalLines = 200,
): Parameters<ToolLoopTracker["recordRead"]>[0] {
  return { path, contentHash, span, totalLines };
}

describe("ToolLoopTracker read-coverage detector", () => {
  it("does not flag the first read of a file", () => {
    const tracker = new ToolLoopTracker();
    const obs = observe("/a.ts", "v1", { start: 1, end: 50 });
    expect(tracker.checkReadRepeat(obs).repeat).toBe(false);
    tracker.recordRead(obs);
  });

  it("flags a re-read fully contained in what was already read", () => {
    const tracker = new ToolLoopTracker();
    const first = observe("/a.ts", "v1", { start: 1, end: 100 });
    tracker.recordRead(first);
    // Different offset/limit, so the argument hash differs and the generic
    // detectors stay silent — this is the case issue #114 is about.
    const contained = observe("/a.ts", "v1", { start: 20, end: 60 });
    const check = tracker.checkReadRepeat(contained);
    expect(check.repeat).toBe(true);
    expect(check.count).toBe(1);
    expect(check.covered).toBe("1-100");
    expect(check.previousFingerprint).toBe("v1");
  });

  it("counts consecutive no-progress reads and reaches the warn floor", () => {
    const tracker = new ToolLoopTracker();
    tracker.recordRead(observe("/a.ts", "v1", { start: 1, end: 100 }));
    const again = observe("/a.ts", "v1", { start: 10, end: 20 });
    expect(tracker.checkReadRepeat(again).count).toBe(1);
    tracker.recordRead(again);
    const third = observe("/a.ts", "v1", { start: 30, end: 40 });
    const check = tracker.checkReadRepeat(third);
    expect(check.count).toBe(READ_REPEAT_WARNING_THRESHOLD);
    expect(check.repeat).toBe(true);
  });

  it("treats a partial overlap as progress and only banks the new lines", () => {
    const tracker = new ToolLoopTracker();
    tracker.recordRead(observe("/a.ts", "v1", { start: 1, end: 50 }));
    const overlapping = observe("/a.ts", "v1", { start: 40, end: 80 });
    expect(tracker.checkReadRepeat(overlapping).repeat).toBe(false);
    tracker.recordRead(overlapping);
    // 1-80 is now covered: a read inside it is no longer progress.
    expect(
      tracker.checkReadRepeat(observe("/a.ts", "v1", { start: 60, end: 75 }))
        .repeat,
    ).toBe(true);
    expect(
      tracker.checkReadRepeat(observe("/a.ts", "v1", { start: 81, end: 90 }))
        .repeat,
    ).toBe(false);
  });

  it("treats plain pagination as progress on every page", () => {
    const tracker = new ToolLoopTracker();
    for (let page = 0; page < 6; page += 1) {
      const span = { start: page * 40 + 1, end: page * 40 + 40 };
      expect(tracker.checkReadRepeat(observe("/a.ts", "v1", span)).repeat).toBe(
        false,
      );
      tracker.recordRead(observe("/a.ts", "v1", span));
    }
  });

  it("resets the streak when a read finally reaches new lines", () => {
    const tracker = new ToolLoopTracker();
    tracker.recordRead(observe("/a.ts", "v1", { start: 1, end: 50 }));
    tracker.recordRead(observe("/a.ts", "v1", { start: 10, end: 20 }));
    tracker.recordRead(observe("/a.ts", "v1", { start: 30, end: 40 }));
    tracker.recordRead(observe("/a.ts", "v1", { start: 51, end: 60 }));
    const check = tracker.checkReadRepeat(observe("/a.ts", "v1", { start: 1, end: 5 }));
    expect(check.count).toBe(1);
  });

  it("resets coverage when the content changes", () => {
    const tracker = new ToolLoopTracker();
    tracker.recordRead(observe("/a.ts", "v1", { start: 1, end: 100 }));
    tracker.recordRead(observe("/a.ts", "v1", { start: 10, end: 20 }));
    const afterEdit = observe("/a.ts", "v2", { start: 10, end: 20 });
    const check = tracker.checkReadRepeat(afterEdit);
    expect(check.repeat).toBe(false);
    expect(check.previousFingerprint).toBe("v1");
    tracker.recordRead(afterEdit);
    // The pre-edit coverage is gone: 1-100 is worth reading again.
    expect(
      tracker.checkReadRepeat(observe("/a.ts", "v2", { start: 1, end: 100 }))
        .repeat,
    ).toBe(false);
  });

  it("keeps files independent, so a multi-file scan never trips", () => {
    const tracker = new ToolLoopTracker();
    for (let i = 0; i < 50; i += 1) {
      const obs = observe(`/file-${i}.ts`, `v${i}`, { start: 1, end: 120 });
      expect(tracker.checkReadRepeat(obs).repeat).toBe(false);
      tracker.recordRead(obs);
    }
    // The same range in a different file is a different question.
    expect(
      tracker.checkReadRepeat(observe("/other.ts", "v0", { start: 1, end: 120 }))
        .repeat,
    ).toBe(false);
  });

  it("flags a read that returned nothing, but never the first one", () => {
    const tracker = new ToolLoopTracker();
    const past = observe("/a.ts", "v1", null, 40);
    expect(tracker.checkReadRepeat(past).repeat).toBe(false);
    tracker.recordRead(past);
    expect(tracker.checkReadRepeat(observe("/a.ts", "v1", null, 40)).repeat).toBe(
      true,
    );
  });

  it("bounds the number of tracked files", () => {
    const tracker = new ToolLoopTracker();
    const first = observe("/file-0.ts", "v0", { start: 1, end: 10 });
    tracker.recordRead(first);
    for (let i = 1; i <= 250; i += 1) {
      tracker.recordRead(observe(`/file-${i}.ts`, `v${i}`, { start: 1, end: 10 }));
    }
    // The oldest entry has been evicted, so its re-read reads as fresh —
    // a missed detection, which is the safe direction.
    expect(tracker.checkReadRepeat(first).repeat).toBe(false);
  });
});

describe("formatReadRepeatNotice", () => {
  const base = {
    count: 2,
    path: "/repo/src/agent/loop-detector.ts",
    startLine: 20,
    endLine: 60,
    totalLines: 900,
    covered: "1-120",
  };

  it("names the file, the range and the coverage without any content", () => {
    const notice = formatReadRepeatNotice(base);
    expect(notice).toContain("loop-detector.ts");
    expect(notice).toContain("lines 20-60");
    expect(notice).toContain("1-120");
    expect(notice).toContain("900");
    expect(notice).toContain("nothing was blocked");
  });

  it("elides a long path from the left so the basename survives", () => {
    const notice = formatReadRepeatNotice({
      ...base,
      path: `/${"deep/".repeat(40)}target.ts`,
    });
    expect(notice).toContain("target.ts");
    expect(notice).toContain("…");
  });

  it("words an empty return honestly", () => {
    const notice = formatReadRepeatNotice({ ...base, startLine: 0, endLine: 0 });
    expect(notice).toContain("returned no lines at all");
  });
});

// -------------------------------------------------------------- end-to-end

function batchCtx(workingDir: string, tracker: ToolLoopTracker) {
  return {
    workingDir,
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
    tracker,
  };
}

function readRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(osFsReadTool);
  return registry;
}

/** Run one `os.fs.read` through the real batch executor and gate. */
async function runRead(
  dir: string,
  tracker: ToolLoopTracker,
  args: Record<string, unknown>,
): Promise<BatchLoopSignal[]> {
  const outcome = await executeBatch(
    toBatchInputs([{ tool: "os.fs.read", args }]),
    readRegistry(),
    batchCtx(dir, tracker),
  );
  expect(outcome.results[0]?.compressed?.status).toBe("ok");
  return outcome.loopSignals;
}

describe("read-coverage detection end to end", () => {
  let dir: string;
  let tracker: ToolLoopTracker;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-read-loop-"));
    tracker = new ToolLoopTracker();
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(join(dir, "src.ts"), `${body}\n`, "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("raises a read_repeat warn for a shifted re-read of the same file", async () => {
    expect(await runRead(dir, tracker, { path: "src.ts" })).toEqual([]);
    // Both re-reads use offsets the first (byte-mode) read never
    // mentioned, so every argument hash differs and only the coverage
    // detector can see that nothing new came back.
    expect(
      await runRead(dir, tracker, { path: "src.ts", offset: 40, limit: 30 }),
    ).toHaveLength(1);
    const signals = await runRead(dir, tracker, {
      path: "src.ts",
      offset: 90,
      limit: 30,
    });
    expect(signals).toHaveLength(1);
    const signal = signals[0]!;
    expect(signal.kind).toBe("warn");
    expect(signal.detector).toBe("read_repeat");
    expect(signal.count).toBe(READ_REPEAT_WARNING_THRESHOLD);
    expect(signal.read?.startLine).toBe(90);
    expect(signal.read?.endLine).toBe(119);
    expect(signal.read?.covered).toBe("1-200");
    // The fingerprint transition proves the content stood still.
    expect(signal.read?.previousFingerprint).toBe(signal.read?.fingerprint);
    // Path and numbers only: no line of the file leaks into the signal.
    expect(JSON.stringify(signal)).not.toContain("line 90");
  });

  it("sees a symlink and its target as one file", async () => {
    await symlink(join(dir, "src.ts"), join(dir, "alias.ts"));
    expect(await runRead(dir, tracker, { path: "src.ts" })).toEqual([]);
    const signals = await runRead(dir, tracker, {
      path: "alias.ts",
      offset: 10,
      limit: 5,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.detector).toBe("read_repeat");
  });

  it("stays silent while paginating a long file", async () => {
    for (let page = 0; page < 4; page += 1) {
      const signals = await runRead(dir, tracker, {
        path: "src.ts",
        offset: page * 50 + 1,
        limit: 50,
      });
      expect(signals).toEqual([]);
    }
  });

  it("stays silent while scanning many distinct files", async () => {
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(dir, `f${i}.ts`), `unique body ${i}\n`, "utf8");
    }
    for (let i = 0; i < 12; i += 1) {
      expect(await runRead(dir, tracker, { path: `f${i}.ts` })).toEqual([]);
    }
  });

  it("goes quiet again after a same-size edit with a pinned mtime", async () => {
    const file = join(dir, "small.ts");
    const pinned = new Date(1_700_000_000_000);
    await writeFile(file, "aaa\nbbb\nccc\n", "utf8");
    await utimes(file, pinned, pinned);

    expect(await runRead(dir, tracker, { path: "small.ts" })).toEqual([]);
    expect(
      await runRead(dir, tracker, { path: "small.ts", offset: 2, limit: 2 }),
    ).toHaveLength(1);

    await writeFile(file, "xxx\nyyy\nzzz\n", "utf8");
    await utimes(file, pinned, pinned);
    // Same size, same mtime, different bytes: the edit must reset coverage.
    expect(
      await runRead(dir, tracker, { path: "small.ts", offset: 1, limit: 3 }),
    ).toEqual([]);
  });

  it("credits a truncated read with only the prefix it returned", async () => {
    // The file is ~1.5 KB; a 400-byte cap returns a few dozen lines. The
    // banked coverage must be that prefix, never the whole 200-line file.
    expect(
      await runRead(dir, tracker, { path: "src.ts", maxBytes: 400 }),
    ).toEqual([]);
    const signals = await runRead(dir, tracker, {
      path: "src.ts",
      maxBytes: 400,
      offset: 5,
      limit: 5,
    });
    expect(signals).toHaveLength(1);
    const read = signals[0]!.read!;
    expect(read.totalLines).toBeGreaterThan(0);
    expect(read.totalLines).toBeLessThan(200);
    expect(read.covered).toBe(`1-${read.totalLines}`);
  });

  it("treats a widened byte window as a new version, not a repeat", async () => {
    // A larger `maxBytes` reads a longer prefix, so the fingerprint moves
    // and coverage resets. That is a deliberately missed detection (the
    // model may genuinely be reaching for content the cap hid), never a
    // false one.
    expect(
      await runRead(dir, tracker, { path: "src.ts", maxBytes: 400 }),
    ).toEqual([]);
    expect(
      await runRead(dir, tracker, { path: "src.ts", maxBytes: 4000, offset: 1, limit: 5 }),
    ).toEqual([]);
  });

  it("records nothing for a failed read", async () => {
    const outcome = await executeBatch(
      toBatchInputs([
        { tool: "os.fs.read", args: { path: "missing.ts" } },
        { tool: "os.fs.read", args: { path: "missing.ts" } },
      ]),
      readRegistry(),
      batchCtx(dir, tracker),
    );
    expect(outcome.results[0]?.compressed?.status).toBe("error");
    expect(
      outcome.loopSignals.filter((s) => s.detector === "read_repeat"),
    ).toEqual([]);
  });
});
