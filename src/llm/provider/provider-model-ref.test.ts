import { describe, expect, it } from "vitest";
import { formatProviderModel, providerModelSeparator, splitProviderModel } from "./provider-model-ref.js";

/** ATO-2773: one reading of a model reference for every input. */
describe("splitProviderModel", () => {
  it("takes both separators and splits at the first one", () => {
    expect(splitProviderModel("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    expect(splitProviderModel("openai:gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    expect(splitProviderModel("openrouter/openai/gpt-oss")).toEqual({ provider: "openrouter", model: "openai/gpt-oss" });
    expect(splitProviderModel("openrouter:openai/gpt-oss")).toEqual({ provider: "openrouter", model: "openai/gpt-oss" });
    expect(splitProviderModel("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(splitProviderModel("local-llama/qwen3:8b")).toEqual({ provider: "local-llama", model: "qwen3:8b" });
  });

  it("refuses a missing side, no separator or whitespace", () => {
    for (const bad of ["", "gpt-5", "/gpt-5", ":gpt-5", "openai/", "openai:", "a b/c"]) {
      expect(splitProviderModel(bad)).toBeNull();
    }
  });

  it("finds the first separator and writes the slash form", () => {
    expect(providerModelSeparator("a:b/c")).toBe(1);
    expect(providerModelSeparator("ab/c:d")).toBe(2);
    expect(providerModelSeparator("abc")).toBe(-1);
    expect(formatProviderModel({ provider: "ollama", model: "qwen3:8b" })).toBe("ollama/qwen3:8b");
  });
});
