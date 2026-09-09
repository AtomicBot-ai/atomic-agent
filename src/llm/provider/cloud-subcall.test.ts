import { describe, it, expect } from "vitest";
import { buildCloudSubcallRequest, CLOUD_SUBCALL_MAX_TOKENS } from "./cloud-subcall.js";

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

describe("the sub-call's own output bound", () => {
  it("bounds a structured sub-call even though the main path sends no cap", () => {
    const req = buildCloudSubcallRequest({
      prompt: "p",
      emitFunctionName: "emit",
      argsSchema: { type: "object" },
    });
    expect(req.maxTokens).toBe(CLOUD_SUBCALL_MAX_TOKENS);
  });

  it("lets the caller override it", () => {
    const req = buildCloudSubcallRequest({
      prompt: "p",
      emitFunctionName: "emit",
      argsSchema: { type: "object" },
      maxTokens: 64,
    });
    expect(req.maxTokens).toBe(64);
  });
});
