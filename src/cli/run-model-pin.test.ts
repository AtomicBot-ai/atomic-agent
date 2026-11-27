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

  // ATO-2773: `/model favorite` writes provider/model; the same id works here.
  it("splits <provider>/<model> when the head is a configured provider", () => {
    const anthropicActive = {
      activeTextProvider: "anthropic",
      providers: [
        ...llm.providers,
        { id: "anthropic", kind: "openai-compatible", defaultChatModel: "claude-sonnet-4-5" },
      ],
    };
    expect(resolveRunModel("openai/gpt-5", anthropicActive)).toEqual({ providerId: "openai", model: "gpt-5" });
    expect(resolveRunModel("openai/gpt-5", llm)).toEqual({ providerId: "openai", model: "gpt-5" });
    // Not a provider head: still one model id on the active provider.
    expect(resolveRunModel("qwen/qwen3-coder", llm)).toEqual({ providerId: "openai", model: "qwen/qwen3-coder" });
    // A colon before the slash is the provider separator, as before.
    expect(resolveRunModel("openai:org/model", llm)).toEqual({ providerId: "openai", model: "org/model" });
  });

  it("keeps a slash id on a router whose own model ids carry a slash", () => {
    const routerActive = {
      activeTextProvider: "or",
      providers: [...llm.providers, { id: "or", kind: "openrouter", defaultChatModel: "openrouter/auto" }],
    };
    expect(resolveRunModel("openai/gpt-oss-120b", routerActive)).toEqual({ providerId: "or", model: "openai/gpt-oss-120b" });
    expect(resolveRunModel("or/auto", routerActive)).toEqual({ providerId: "or", model: "or/auto" });
    // The colon still names the other provider.
    expect(resolveRunModel("openai:gpt-5", routerActive)).toEqual({ providerId: "openai", model: "gpt-5" });
    const litellm = {
      activeTextProvider: "proxy",
      providers: [...llm.providers, { id: "proxy", kind: "openai-compatible", defaultChatModel: "openai/gpt-4o" }],
    };
    expect(resolveRunModel("openai/gpt-4o-mini", litellm)).toEqual({ providerId: "proxy", model: "openai/gpt-4o-mini" });
  });

  it("keeps a slash id on AI/ML API even with no chat model configured (ATO-2773)", () => {
    // Its built-in default is `openai/gpt-5.5-...`, so `openai/...` here
    // is that router's model, not the configured `openai` provider.
    const aiml = {
      activeTextProvider: "ai",
      providers: [...llm.providers, { id: "ai", kind: "aimlapi" }],
    };
    expect(resolveRunModel("openai/gpt-4o", aiml)).toEqual({ providerId: "ai", model: "openai/gpt-4o" });
  });

  it("refuses a per-turn model on a local provider and an empty value", () => {
    expect(resolveRunModel("local-llama:qwen", llm)).toMatchObject({
      error: expect.stringContaining("works on cloud providers only"),
    });
    expect(resolveRunModel("ollama:qwen3:8b", llm)).toMatchObject({
      error: expect.stringContaining("works on cloud providers only"),
    });
    expect(resolveRunModel("ollama/qwen3:8b", llm)).toMatchObject({
      error: expect.stringContaining("works on cloud providers only"),
    });
    expect(resolveRunModel(" ", llm)).toEqual({
      error: "--model needs a model id or <provider>/<model>",
    });
  });
});
