import { describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { ToolRegistry, type ToolContext } from "../../tools/tool-registry.js";
import { executeBatch, toBatchInputs } from "./batch-scheduler.js";

/**
 * Seam for ATO-2440: the turn's `toolFilter` reaches the tool, so a tool
 * that starts worker turns (`subagent.run`, `fusion.delegate`) can hand
 * it on and `run --disallowed-tools` holds for the workers too.
 */
describe("batch executor: the turn's tool filter in the tool context", () => {
  function registry(seen: Array<ToolContext["toolFilter"]>): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe.capture",
      description: "probe",
      readonly: true,
      run: async (_args, ctx) => {
        seen.push(ctx.toolFilter);
        return compressToolResult({ tool: "probe.capture", status: "ok", output: "ok" });
      },
    });
    return reg;
  }

  const call = toBatchInputs([{ tool: "probe.capture", args: {} }]);
  const base = {
    workingDir: "/repo",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };

  it("hands the turn's filter to the tool", async () => {
    const seen: Array<ToolContext["toolFilter"]> = [];
    const filter = (name: string): boolean => name !== "os.shell.run";
    await executeBatch(call, registry(seen), { ...base, toolFilter: filter });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(filter);
  });

  it("hands none when the turn has none", async () => {
    const seen: Array<ToolContext["toolFilter"]> = [];
    await executeBatch(call, registry(seen), base);
    expect(seen).toEqual([undefined]);
  });
});
