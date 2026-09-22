import { describe, it, expect } from "vitest";
import type { ToolContext } from "../../tool-registry.js";
import { osProcListTool } from "./proc-list.js";

function makeCtx(): ToolContext {
  return {
    workingDir: process.cwd(),
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.proc.list", () => {
  it("returns a non-empty process list with this process in it", async () => {
    const result = await osProcListTool.run({ limit: 10000 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.total).toBeGreaterThan(0);
    const processes = result.details.processes as { pid: number }[];
    expect(processes.some((p) => p.pid === process.pid)).toBe(true);
  });

  it("filters by substring (case-insensitive)", async () => {
    const result = await osProcListTool.run({ filter: "node" }, makeCtx());
    const processes = result.details.processes as { command: string }[];
    expect(processes.length).toBeGreaterThan(0);
    expect(
      processes.every((p) => p.command.toLowerCase().includes("node")),
    ).toBe(true);
  });

  it("respects limit", async () => {
    const result = await osProcListTool.run({ limit: 3 }, makeCtx());
    expect(result.details.returned).toBeLessThanOrEqual(3);
    expect((result.details.processes as unknown[]).length).toBeLessThanOrEqual(
      3,
    );
  });

  // `formatTable`'s `PID PPID USER CPU% MEM% COMMAND` row is line 1,
  // so the compressor's default 12-line tail drops the column header
  // and every row but the last twelve — of which the 385-char
  // head-slice then keeps about five. `listingResultCaps` budgets the
  // rows the call actually returns.
  it("keeps the column header and rows past the old 12-line tail", async () => {
    const result = await osProcListTool.run({ limit: 100 }, makeCtx());
    const returned = result.details.returned as number;
    // Any host that can run this suite runs far more than 12
    // processes; if one somehow does not there is nothing to keep.
    expect(returned).toBeGreaterThan(20);

    const lines = result.summary.split("\n");
    expect(lines[0]).toMatch(/^PID\s+PPID\s+USER\s+CPU%\s+MEM%\s+COMMAND$/);
    expect(result.summary.length).toBeGreaterThan(385);
    // Rows the old tail would have cut: the 13th row counted from the
    // top is outside the last twelve of a 100-row table. Match the row
    // start, so a PID cannot be satisfied by a PPID column or by a run
    // of digits inside a command path.
    const processes = result.details.processes as { pid: number }[];
    expect(lines.length).toBeGreaterThan(13);
    const startsWithPid = (pid: number) =>
      lines.some((l) => new RegExp(`^${pid}\\s`).test(l));
    expect(startsWithPid(processes[0]!.pid)).toBe(true);
    expect(startsWithPid(processes[12]!.pid)).toBe(true);
  });

  // Small listings must not come out worse than they did before the
  // caps: a filter narrow enough to be useful is never cut, whatever
  // the length of the matched command paths.
  it("does not truncate a narrow filtered listing", async () => {
    const result = await osProcListTool.run(
      { filter: process.execPath },
      makeCtx(),
    );
    const returned = result.details.returned as number;
    expect(returned).toBeGreaterThan(0);
    if (returned > 20) return;
    expect(result.truncated).toBe(false);
    expect(result.summary).not.toContain("[truncated]");
    expect(result.summary).toContain(process.execPath);
  });
});
