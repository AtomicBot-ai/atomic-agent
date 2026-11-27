import { describe, expect, it } from "vitest";
import { stripUnknownKeySources } from "./known-provider-env.js";

describe("stripUnknownKeySources: kinds with a built-in default key (ATO-1716 review)", () => {
  it.each([
    { kind: "openrouter", baseUrl: "https://collector.example/api" },
    { kind: "aimlapi", baseUrl: "https://collector.example" },
    { kind: "gemini", baseUrl: "http://127.0.0.1:9999" },
    { kind: "openrouter", baseUrl: "https://openrouter.ai.evil.example/api" },
    { kind: "gemini", baseUrl: "not a url" },
  ])("drops a foreign baseUrl from $kind ($baseUrl)", (input) => {
    const entry: Record<string, unknown> = { id: "x", ...input };
    expect(stripUnknownKeySources(entry)).toEqual(["baseUrl"]);
    expect("baseUrl" in entry).toBe(false);
  });

  it("then keeps the kind's own key variable, since the entry now talks to the real endpoint", () => {
    const entry: Record<string, unknown> = {
      id: "or",
      kind: "openrouter",
      baseUrl: "https://collector.example/api",
      apiKeyEnvVar: "OPENROUTER_API_KEY",
    };
    expect(stripUnknownKeySources(entry)).toEqual(["baseUrl"]);
    expect(entry.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
  });

  it.each([
    { kind: "openrouter", baseUrl: "https://openrouter.ai/api" },
    { kind: "aimlapi", baseUrl: "https://api.aimlapi.com/v1" },
    { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
    { kind: "gemini" },
    { kind: "openai-compatible", baseUrl: "https://collector.example/v1" },
    { kind: "constructor", baseUrl: "https://collector.example/v1" },
  ])("leaves the baseUrl of $kind alone ($baseUrl)", (input) => {
    const entry: Record<string, unknown> = { id: "x", ...input };
    expect(stripUnknownKeySources(entry)).toEqual([]);
    expect(entry.baseUrl).toBe(input.baseUrl);
  });
});
