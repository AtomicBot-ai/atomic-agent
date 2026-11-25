import { describe, expect, it } from "vitest";

import { modelsDevCatalogEntry } from "./models-dev-catalog.js";

const moonshot = { id: "moonshot", kind: "openai-compatible", baseUrl: "https://api.moonshot.ai" };

describe("modelsDevCatalogEntry", () => {
  it("prices and sizes a preset model from the bundled snapshot", () => {
    const row = modelsDevCatalogEntry(moonshot, "kimi-k3.1-pro");
    // Moonshot's list price for K3.1 Pro, per 1M tokens.
    expect(row?.pricing).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 });
    expect(row?.contextWindow).toBe(1_048_576);
    expect(row?.maxOutputTokens).toBeGreaterThan(0);
  });

  it("carries limits and prices only, never capabilities", () => {
    const row = modelsDevCatalogEntry(moonshot, "kimi-k3.1-pro");
    expect(row).toMatchObject({
      id: "kimi-k3.1-pro",
      kind: "chat",
      supportsVision: false,
      supportsTools: "parallel",
      supportsPromptCache: false,
      reasoningFormat: "none",
    });
  });

  it("strips Gemini's models/ prefix and keeps the id it was asked for", () => {
    const row = modelsDevCatalogEntry({ id: "gemini", kind: "gemini" }, "models/gemini-2.5-flash");
    expect(row?.id).toBe("models/gemini-2.5-flash");
    expect(row?.pricing?.input).toBeGreaterThan(0);
  });

  it("falls back to a case-insensitive match", () => {
    const snapshot = { moonshotai: { "Kimi-Test": { context: 1000, cost: { input: 1, output: 2 } } } };
    expect(modelsDevCatalogEntry(moonshot, "kimi-test", snapshot)?.pricing).toEqual({
      input: 1,
      output: 2,
    });
  });

  it("leaves a row without a price unpriced", () => {
    const snapshot = { moonshotai: { "kimi-free": { context: 8000 } } };
    const row = modelsDevCatalogEntry(moonshot, "kimi-free", snapshot);
    expect(row?.contextWindow).toBe(8000);
    expect(row).not.toHaveProperty("pricing");
    expect(row).not.toHaveProperty("maxOutputTokens");
  });

  it("knows nothing about an unknown model or an unmapped provider", () => {
    expect(modelsDevCatalogEntry(moonshot, "no-such-model")).toBeUndefined();
    expect(
      modelsDevCatalogEntry({ id: "custom", kind: "openai-compatible", baseUrl: "https://llm.example.com" }, "kimi-k3.1-pro"),
    ).toBeUndefined();
  });
});
