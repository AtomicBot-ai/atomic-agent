import { describe, expect, it } from "vitest";
import {
  OPENROUTER_CHAT_MODEL_ORDER,
  OPENROUTER_MODELS_CATALOG,
} from "./openrouter-models-catalog.js";

describe("OPENROUTER_MODELS_CATALOG", () => {
  it("lists the current Anthropic chat models", () => {
    // The previous snapshot asserted the opposite: no `anthropic/*` row
    // was allowed here, mirroring the vendor filter that used to sit in
    // `scoreChat`. Both are gone — OpenRouter serves Claude on the same
    // OpenAI-shaped chat-completions surface as everything else, so
    // hiding it only cost operators the models they asked for.
    for (const id of ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]) {
      expect(OPENROUTER_MODELS_CATALOG.get(id)?.kind).toBe("chat");
      expect(OPENROUTER_CHAT_MODEL_ORDER).toContain(id);
    }
  });

  it("lists the current Gemini chat models", () => {
    for (const id of ["google/gemini-3.7-flash", "google/gemini-3.5-flash"]) {
      expect(OPENROUTER_MODELS_CATALOG.get(id)?.kind).toBe("chat");
      expect(OPENROUTER_CHAT_MODEL_ORDER).toContain(id);
    }
  });

  it("gives every chat row a positive context window and a price", () => {
    for (const [id, entry] of OPENROUTER_MODELS_CATALOG) {
      if (entry.kind !== "chat") continue;
      expect(entry.contextWindow, id).toBeGreaterThan(0);
      expect(entry.pricing, id).toBeDefined();
      expect(entry.pricing!.input, id).toBeGreaterThanOrEqual(0);
      expect(entry.pricing!.output, id).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the picker order free of duplicates and in sync with the map", () => {
    // The chat rows now come from two sibling modules, so a copy/paste
    // between them would otherwise land silently as a duplicate key.
    const order = OPENROUTER_CHAT_MODEL_ORDER;
    expect(new Set(order).size).toBe(order.length);
    const chatIds = [...OPENROUTER_MODELS_CATALOG]
      .filter(([, entry]) => entry.kind === "chat")
      .map(([id]) => id);
    expect([...order].sort()).toEqual([...chatIds].sort());
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

  it("includes Kimi K2.7 and GLM picks", () => {
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("moonshotai/kimi-k2.7-code");
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("z-ai/glm-4.7-flash");
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("z-ai/glm-5.1");
    expect(OPENROUTER_CHAT_MODEL_ORDER).toContain("z-ai/glm-5.2");
  });

  it("includes the latest OpenRouter fallback picks", () => {
    expect(OPENROUTER_CHAT_MODEL_ORDER).toEqual(
      expect.arrayContaining([
        "qwen/qwen3.7-max",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-pro",
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
