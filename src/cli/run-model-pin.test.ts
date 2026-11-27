import { describe, expect, it } from "vitest";

import { resolveRunModel } from "./run-model-pin.js";

/** ATO-2307: what `run --model` pins each turn to. */
describe("resolveRunModel", () => {
  const llm = {
    activeTextProvider: "openai",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
      { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
      { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    ],
  };

  it("reads a bare model id as a model on the active provider", () => {
    expect(resolveRunModel("gpt-5-mini", llm)).toEqual({ providerId: "openai", model: "gpt-5-mini" });
  });

  it("reads a configured provider id as that provider with its own model", () => {
    expect(resolveRunModel("local-llama", llm)).toEqual({ providerId: "local-llama" });
  });

  it("splits <provider>:<model> only when the head is a configured provider", () => {
    expect(resolveRunModel("openai:gpt-5", llm)).toEqual({ providerId: "openai", model: "gpt-5" });
    expect(resolveRunModel("qwen3:8b", llm)).toEqual({ providerId: "openai", model: "qwen3:8b" });
    expect(resolveRunModel("openai:", llm)).toEqual({ providerId: "openai" });
  });

  it("refuses a per-turn model on a local provider and an empty value", () => {
    expect(resolveRunModel("local-llama:qwen", llm)).toMatchObject({
      error: expect.stringContaining("works on cloud providers only"),
    });
    expect(resolveRunModel("ollama:qwen3:8b", llm)).toMatchObject({
      error: expect.stringContaining("works on cloud providers only"),
    });
    expect(resolveRunModel(" ", llm)).toEqual({
      error: "--model needs a model id or <provider>:<model>",
    });
  });
});
