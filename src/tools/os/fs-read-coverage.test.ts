import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { osFsReadTool } from "./fs-read.js";
import { parseReadCoverage, type ReadCoverageDetail } from "./fs-read-coverage.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

async function readCoverageOf(
  dir: string,
  args: Record<string, unknown>,
): Promise<ReadCoverageDetail> {
  const result = await osFsReadTool.run(args, makeCtx(dir));
  expect(result.status).toBe("ok");
  const coverage = parseReadCoverage(result.details);
  expect(coverage).not.toBeNull();
  return coverage!;
}

describe("os.fs.read coverage detail", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-read-coverage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the whole prefix as the returned range in byte mode", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8");
    const coverage = await readCoverageOf(dir, { path: "a.txt" });
    expect(coverage.startLine).toBe(1);
    expect(coverage.endLine).toBe(3);
    expect(coverage.totalLines).toBe(3);
  });

  it("keeps the byte-mode top-level details free of line fields", async () => {
    // Byte-mode results have never carried `totalLines` / `startLine`, and
    // consumers tell the two modes apart by exactly that. The coverage
    // detail must not smuggle those fields up to the top level.
    await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8");
    const result = await osFsReadTool.run({ path: "a.txt" }, makeCtx(dir));
    expect(result.details.totalLines).toBeUndefined();
    expect(result.details.startLine).toBeUndefined();
    expect(result.details.endLine).toBeUndefined();
  });

  it("reports the returned range, not the requested one, in line mode", async () => {
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4\n5\n", "utf8");
    // limit 99 is clamped to the end of the file; the coverage detail must
    // describe what came back (2-5), not what was asked for (2-100).
    const coverage = await readCoverageOf(dir, {
      path: "a.txt",
      offset: 2,
      limit: 99,
    });
    expect(coverage.startLine).toBe(2);
    expect(coverage.endLine).toBe(5);
    expect(coverage.totalLines).toBe(5);
  });

  it("resolves a negative offset to the range it actually returned", async () => {
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4\n5\n", "utf8");
    const coverage = await readCoverageOf(dir, { path: "a.txt", offset: -2 });
    expect(coverage.startLine).toBe(4);
    expect(coverage.endLine).toBe(5);
  });

  it("gives a symlink and its target the same identity", async () => {
    await writeFile(join(dir, "real.txt"), "alpha\nbeta\n", "utf8");
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
    const direct = await readCoverageOf(dir, { path: "real.txt" });
    const viaLink = await osFsReadTool.run(
      { path: "link.txt" },
      makeCtx(dir),
    );
    const linked = parseReadCoverage(viaLink.details)!;
    expect(linked.path).toBe(direct.path);
    expect(linked.path).toBe(await realpath(join(dir, "real.txt")));
    // The path shown to the model and the UI is still the one asked for.
    expect(viaLink.details.path).toBe(join(dir, "link.txt"));
  });

  it("changes the fingerprint on a same-size replacement with an unchanged mtime", async () => {
    const file = join(dir, "a.txt");
    // A fixed timestamp on both sides of the edit: `utimes` has
    // millisecond resolution, so pinning it explicitly is the only way to
    // get a byte-identical mtime before and after.
    const pinned = new Date(1_700_000_000_000);
    await writeFile(file, "aaaa\nbbbb\n", "utf8");
    await utimes(file, pinned, pinned);
    const before = await stat(file);
    const first = await readCoverageOf(dir, { path: "a.txt" });

    await writeFile(file, "xxxx\nyyyy\n", "utf8");
    // Force size AND mtime back to their pre-edit values: a fingerprint
    // built from stat metadata would call this file unchanged.
    await utimes(file, pinned, pinned);
    const after = await stat(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const second = await readCoverageOf(dir, { path: "a.txt" });
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it("keeps the fingerprint stable across reads of different ranges", async () => {
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4\n5\n6\n", "utf8");
    const head = await readCoverageOf(dir, { path: "a.txt", offset: 1, limit: 2 });
    const tail = await readCoverageOf(dir, { path: "a.txt", offset: 5, limit: 2 });
    expect(tail.contentHash).toBe(head.contentHash);
  });

  it("credits a byte-truncated read with only the lines it returned", async () => {
    await writeFile(join(dir, "big.txt"), "aaaa\nbbbb\ncccc\ndddd\n", "utf8");
    // 10 bytes reaches into line 3 only; lines 3 and 4 were never returned
    // in full and must not appear as covered.
    const result = await osFsReadTool.run(
      { path: "big.txt", maxBytes: 10 },
      makeCtx(dir),
    );
    expect(result.details.truncated).toBe(true);
    const coverage = parseReadCoverage(result.details)!;
    expect(coverage.startLine).toBe(1);
    expect(coverage.endLine).toBeLessThan(4);
    expect(coverage.totalLines).toBeLessThan(4);
  });

  it("reports an empty span for a read past the end of the file", async () => {
    await writeFile(join(dir, "a.txt"), "1\n2\n", "utf8");
    const coverage = await readCoverageOf(dir, {
      path: "a.txt",
      offset: 99,
      limit: 5,
    });
    expect(coverage.startLine).toBe(0);
    expect(coverage.endLine).toBe(0);
    expect(coverage.totalLines).toBe(2);
  });

  it("reports an empty span for an empty file", async () => {
    await writeFile(join(dir, "empty.txt"), "", "utf8");
    const coverage = await readCoverageOf(dir, { path: "empty.txt" });
    expect(coverage.startLine).toBe(0);
    expect(coverage.endLine).toBe(0);
    expect(coverage.totalLines).toBe(0);
  });
});

describe("parseReadCoverage", () => {
  const valid = {
    path: "/tmp/a.ts",
    contentHash: "abc123",
    startLine: 2,
    endLine: 4,
    totalLines: 9,
  };

  it("accepts a well-formed detail", () => {
    expect(parseReadCoverage({ readCoverage: valid })).toEqual(valid);
  });

  it("returns null when the detail is absent (older or replayed results)", () => {
    expect(parseReadCoverage({ path: "/tmp/a.ts" })).toBeNull();
  });

  it.each([
    ["missing path", { ...valid, path: "" }],
    ["missing hash", { ...valid, contentHash: 1 }],
    ["inverted range", { ...valid, startLine: 8, endLine: 4 }],
    ["half-empty range", { ...valid, startLine: 0, endLine: 4 }],
    ["negative line", { ...valid, startLine: -1, endLine: 4 }],
    ["fractional line", { ...valid, startLine: 1.5 }],
  ])("rejects a malformed detail (%s)", (_label, detail) => {
    expect(parseReadCoverage({ readCoverage: detail })).toBeNull();
  });
});
