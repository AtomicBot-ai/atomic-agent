import { describe, it, expect } from "vitest";
import { buildCloudSubcallRequest } from "./cloud-subcall.js";

describe("buildCloudSubcallRequest", () => {
  it("exposes the synthetic emit function with tool_choice 'auto'", () => {
    // Qwen-thinking via OpenRouter rejects both `tool_choice: "required"`
    // and the explicit `{ type: "function", function: { name } }` object
    // form with `400 InvalidParameter`. We pin `"auto"` so the sub-call
    // remains valid against every supported native_tools provider; with
    // only one tool exposed, the model has effectively one good choice.
    const req = buildCloudSubcallRequest({
      prompt: "emit facts",
      emitFunctionName: "emit_reflection",
      argsSchema: { type: "object", properties: {} },
    });
    expect(req.tools).toHaveLength(1);
    expect(req.toolChoice).toBe("auto");
    expect(req.parallelToolCalls).toBe(false);
  });
});
