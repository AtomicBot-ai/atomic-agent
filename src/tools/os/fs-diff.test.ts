import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { osFsDiffTool } from "./fs-diff.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs.diff", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-diff-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("diffs two files on disk with +/- counts", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(dir, "b.txt"), "one\nTWO\nthree\nfour\n", "utf8");
    const result = await osFsDiffTool.run(
      { aPath: "a.txt", bPath: "b.txt" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.details.added).toBe(2);
    expect(result.details.removed).toBe(1);
    expect(result.details.identical).toBe(false);
    expect(result.summary).toContain("--- a.txt");
    expect(result.summary).toContain("+++ b.txt");
  });

  it("diffs inline strings", async () => {
    const result = await osFsDiffTool.run(
      { aText: "alpha\nbeta\n", bText: "alpha\nBETA\n", aLabel: "old", bLabel: "new" },
      makeCtx(dir),
    );
    expect(result.details.identical).toBe(false);
    expect(result.summary).toContain("-beta");
    expect(result.summary).toContain("+BETA");
    expect(result.summary).toContain("--- old");
    expect(result.summary).toContain("+++ new");
  });

  it("returns 'identical' marker when inputs match", async () => {
    const result = await osFsDiffTool.run(
      { aText: "hello\n", bText: "hello\n" },
      makeCtx(dir),
    );
    expect(result.details.identical).toBe(true);
    expect(result.summary).toBe("(files are identical)");
  });

  it("refuses to diff when a side specifies both path and text", async () => {
    await writeFile(join(dir, "f.txt"), "x", "utf8");
    await expect(
      osFsDiffTool.run(
        { aPath: "f.txt", aText: "x", bText: "y" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/must not set both/);
  });

  it("refuses when neither path nor text is given for a side", async () => {
    await expect(
      osFsDiffTool.run({ aText: "x" }, makeCtx(dir)),
    ).rejects.toThrow(/requires either `bPath` or `bText`/);
  });
});
