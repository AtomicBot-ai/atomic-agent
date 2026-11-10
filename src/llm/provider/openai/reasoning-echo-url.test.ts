import { describe, expect, it } from "vitest";

import { requiresReasoningEcho } from "./reasoning-echo-url.js";

describe("requiresReasoningEcho (ATO-1397)", () => {
  it("is on for DeepSeek's API", () => {
    expect(requiresReasoningEcho("https://api.deepseek.com")).toBe(true);
    expect(requiresReasoningEcho("https://api.deepseek.com/v1")).toBe(true);
    expect(requiresReasoningEcho("https://API.DeepSeek.com.")).toBe(true);
  });

  it("is off everywhere else", () => {
    expect(requiresReasoningEcho("https://api.openai.com")).toBe(false);
    expect(requiresReasoningEcho("https://openrouter.ai/api")).toBe(false);
    expect(requiresReasoningEcho("https://notdeepseek.com")).toBe(false);
    expect(requiresReasoningEcho("http://127.0.0.1:8080")).toBe(false);
    expect(requiresReasoningEcho(undefined)).toBe(false);
    expect(requiresReasoningEcho("not a url")).toBe(false);
  });
});
