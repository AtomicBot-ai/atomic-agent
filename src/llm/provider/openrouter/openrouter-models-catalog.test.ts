import { describe, expect, it } from "vitest";
import {
  OPENROUTER_CHAT_MODEL_ORDER,
  OPENROUTER_MODELS_CATALOG,
} from "./openrouter-models-catalog.js";

describe("OPENROUTER_MODELS_CATALOG", () => {
  it("does not list Anthropic chat models", () => {
    for (const [id, entry] of OPENROUTER_MODELS_CATALOG) {
      if (entry.kind !== "chat") continue;
      expect(id.startsWith("anthropic/")).toBe(false);
    }
  });

  it("does not list Gemini chat models", () => {
    for (const [id, entry] of OPENROUTER_MODELS_CATALOG) {
      if (entry.kind !== "chat") continue;
      expect(/gemini/i.test(id)).toBe(false);
    }
    for (const id of OPENROUTER_CHAT_MODEL_ORDER) {
      expect(/gemini/i.test(id)).toBe(false);
    }
  });

  it("orders TUI chat picks with openrouter/auto first", () => {
    expect(OPENROUTER_CHAT_MODEL_ORDER[0]).toBe("openrouter/auto");
    for (const id of OPENROUTER_CHAT_MODEL_ORDER) {
      expect(OPENROUTER_MODELS_CATALOG.has(id)).toBe(true);
    }
  });

  it("includes Qwen 3.6 slugs aligned with local catalog", () => {
    expect(OPENROUTER_MODELS_CATALOG.has("qwen/qwen3.6-35b-a3b")).toBe(true);
    expect(OPENROUTER_MODELS_CATALOG.has("qwen/qwen3.5-35b-a3b")).toBe(false);
    expect(OPENROUTER_MODELS_CATALOG.has("qwen/qwen3.5-flash-02-23")).toBe(false);
  });

  it("includes Kimi K2.6 and GLM picks", () => {
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("moonshotai/kimi-k2.6");
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("z-ai/glm-4.7-flash");
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("z-ai/glm-5");
  });

  it("includes the latest OpenRouter fallback picks", () => {
    expect(OPENROUTER_CHAT_MODEL_ORDER).toEqual(
      expect.arrayContaining([
        "qwen/qwen3.7-max",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash:free",
        "x-ai/grok-4.3",
        "mistralai/mistral-medium-3-5",
        "minimax/minimax-m3",
        "minimax/minimax-m2.7",
        "openai/gpt-5.5",
        "openai/gpt-5.4-nano",
      ]),
    );
  });
});
