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
    const result = await osProcListTool.run(
      { filter: "node" },
      makeCtx(),
    );
    const processes = result.details.processes as { command: string }[];
    expect(processes.length).toBeGreaterThan(0);
    expect(
      processes.every((p) => p.command.toLowerCase().includes("node")),
    ).toBe(true);
  });

  it("respects limit", async () => {
    const result = await osProcListTool.run({ limit: 3 }, makeCtx());
    expect(result.details.returned).toBeLessThanOrEqual(3);
    expect((result.details.processes as unknown[]).length).toBeLessThanOrEqual(3);
  });
});
