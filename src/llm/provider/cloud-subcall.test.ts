import { describe, it, expect } from "vitest";
import { buildCloudSubcallRequest } from "./cloud-subcall.js";

describe("buildCloudSubcallRequest", () => {
  it("forces tool_choice required with parallel_tool_calls false", () => {
    const req = buildCloudSubcallRequest({
      prompt: "emit facts",
      emitFunctionName: "emit_reflection",
      argsSchema: { type: "object", properties: {} },
    });
    expect(req.tools).toHaveLength(1);
    expect(req.toolChoice).toEqual({
      type: "function",
      function: { name: "emit_reflection" },
    });
    expect(req.parallelToolCalls).toBe(false);
  });
});
