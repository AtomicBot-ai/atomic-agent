import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullToolResult } from "../../../compressor/result-compressor.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsGlobTool } from "./fs-glob.js";

function makeCtx(workingDir: string, signal?: AbortSignal): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: signal ?? new AbortController().signal,
  };
}

/** A clock that moves `stepMs` every time the walk looks at it. */
function steppingClock(stepMs: number, onTick?: (ticks: number) => void) {
  let t = 0;
  let ticks = 0;
  return () => {
    ticks++;
    onTick?.(ticks);
    t += stepMs;
    return t;
  };
}

const ROOMY = { maxMs: 60_000, maxEntries: 1_000_000 };

describe("os.fs.glob walk budget", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-glob-budget-"));
    for (const sub of ["a", "b", "c", "d"]) {
      await mkdir(join(dir, sub));
      for (let i = 0; i < 5; i++) {
        await writeFile(join(dir, sub, `f${i}.ts`), "", "utf8");
      }
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the old result shape when the walk finishes within budget", async () => {
    const tool = buildOsFsGlobTool({ budget: ROOMY });
    const result = await tool.run({ pattern: "**/*.ts" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect((result.details.files as string[]).length).toBe(20);
    expect(result.details.truncated).toBe(false);
    expect(result.details).not.toHaveProperty("stoppedBy");
    expect(result.details).not.toHaveProperty("note");
    expect(result.summary).not.toContain("partial results");
  });

  it("returns partial results with a leading note at the entry cap", async () => {
    const tool = buildOsFsGlobTool({
      budget: { maxMs: 60_000, maxEntries: 8 },
    });
    const result = await tool.run({ pattern: "**/*.ts" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.stoppedBy).toBe("entries");
    expect(result.details.scanned).toBe(8);
    expect(result.details.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    const files = result.details.files as string[];
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(20);
    expect(result.summary.startsWith("[partial results")).toBe(true);
    expect(result.summary).toContain("entry limit");
    expect(result.summary).toContain("Narrow the pattern or the root");
    expect(result.details.note).toBe(result.summary.split("\n")[0]);
    // The uncompressed copy handed to full-result consumers carries it too.
    expect(fullToolResult(result).summary.startsWith("[partial results")).toBe(
      true,
    );
  });

  it("stops on the wall-clock budget using the injected clock", async () => {
    const tool = buildOsFsGlobTool({
      budget: { maxMs: 100, maxEntries: 1_000_000 },
      now: steppingClock(10),
    });
    const result = await tool.run({ pattern: "**/*.ts" }, makeCtx(dir));
    expect(result.details.stoppedBy).toBe("time");
    expect(result.details.elapsedMs as number).toBeGreaterThanOrEqual(100);
    expect(result.details.truncated).toBe(true);
    expect((result.details.files as string[]).length).toBeLessThan(20);
    expect(result.summary).toContain("time limit");
  });

  it("still notes a stop when nothing matched before it", async () => {
    const tool = buildOsFsGlobTool({
      budget: { maxMs: 60_000, maxEntries: 1 },
    });
    const result = await tool.run({ pattern: "**/*.nope" }, makeCtx(dir));
    expect(result.details.files).toEqual([]);
    expect(result.summary).toContain("partial results");
    expect(result.summary).toContain("(no matches)");
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = buildOsFsGlobTool({ budget: ROOMY });
    await expect(
      tool.run({ pattern: "**/*.ts" }, makeCtx(dir, controller.signal)),
    ).rejects.toThrow();
  });

  it("stops walking and rejects when cancelled mid-walk", async () => {
    const controller = new AbortController();
    let ticksAtAbort = 0;
    let ticksSeen = 0;
    const tool = buildOsFsGlobTool({
      budget: ROOMY,
      now: steppingClock(1, (ticks) => {
        ticksSeen = ticks;
        if (ticks === 5) {
          ticksAtAbort = ticks;
          controller.abort();
        }
      }),
    });
    await expect(
      tool.run({ pattern: "**/*.ts" }, makeCtx(dir, controller.signal)),
    ).rejects.toThrow();
    // The check that saw the abort was the last one: no further reads.
    expect(ticksAtAbort).toBe(5);
    expect(ticksSeen).toBe(5);
  });
});
