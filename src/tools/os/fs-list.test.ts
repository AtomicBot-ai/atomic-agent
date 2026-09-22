import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { osFsListTool } from "./fs-list.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs.list summary caps", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-list-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `count` files whose names are long enough to blow a 6000-char budget. */
  async function fillWithFiles(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const name = `report-${String(i).padStart(4, "0")}-${"x".repeat(40)}.txt`;
      await writeFile(join(dir, name), "x", "utf8");
    }
  }

  it("keeps the header when the rows have to be clipped", async () => {
    await fillWithFiles(300);
    const result = await osFsListTool.run(
      { path: ".", maxEntries: 300 },
      makeCtx(dir),
    );

    // The header is the part that cannot be reconstructed from the rows.
    // A tail-slice, or a row list long enough to crowd it out, loses it.
    const lines = result.summary.split("\n");
    expect(lines[0]).toBe(`path: ${dir}`);
    expect(result.summary).toContain("total: 300 entries");
    expect(result.summary).toContain("[showing 300/300]");
    expect(result.summary).toContain("sort: name asc");

    // The clip is announced with a count that adds up, not with a bare
    // "… [truncated]" in the middle of a filename.
    const note = /… (\d+) more entries not shown/.exec(result.summary);
    expect(note).not.toBeNull();
    const rows = lines.filter((line) => line.startsWith("file ")).length;
    expect(rows + Number(note![1])).toBe(300);
    expect(result.summary).not.toContain("[truncated]");

    // And it fits the budget, so nothing is cut a second time at render.
    expect(result.summary.length).toBeLessThanOrEqual(6000);
  });

  it("leaves a listing that fits alone", async () => {
    await fillWithFiles(12);
    const result = await osFsListTool.run({ path: "." }, makeCtx(dir));

    expect(result.summary).toContain("report-0000-");
    expect(result.summary).toContain("report-0011-");
    expect(result.summary).not.toContain("not shown");
    expect(result.summary).not.toContain("[truncated]");
    expect(result.truncated).toBe(false);
  });

  it("carries a default-sized listing of ordinary names whole", async () => {
    // 200 short names is the shape of an ordinary source directory, and
    // the default `maxEntries`. It must not be clipped at all.
    for (let i = 0; i < 200; i += 1) {
      await writeFile(join(dir, `f${String(i).padStart(3, "0")}.ts`), "x");
    }
    const result = await osFsListTool.run({ path: "." }, makeCtx(dir));

    expect(result.summary).toContain("f000.ts");
    expect(result.summary).toContain("f199.ts");
    expect(result.summary).not.toContain("not shown");
    expect(result.truncated).toBe(false);
  });
});
