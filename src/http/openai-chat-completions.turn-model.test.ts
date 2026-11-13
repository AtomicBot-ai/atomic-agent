import { afterEach, describe, expect, it, vi } from "vitest";

import * as configuration from "../config/index.js";
import { parseTurnModel } from "./openai-chat-completions.js";

/**
 * ATO-1148: the desktop asks for a project's own cloud model per turn
 * with `provider_id` + `provider_model`. A local provider is refused:
 * its model is one per agent.
 */
function withProviders() {
  const config = configuration.loadConfig();
  config.llm = {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
      { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", defaultChatModel: "qwen" },
      { id: "openrouter", kind: "openrouter", apiKey: "k", defaultChatModel: "openai/gpt-5" },
    ],
  } as never;
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
}

describe("parseTurnModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is null when the request names neither", () => {
    withProviders();
    expect(parseTurnModel({})).toBeNull();
    expect(parseTurnModel({ provider_id: null, provider_model: null })).toBeNull();
  });

  it("takes a cloud provider and model", () => {
    withProviders();
    expect(parseTurnModel({ provider_id: "openrouter", provider_model: " anthropic/claude-sonnet-5 " }))
      .toEqual({ providerId: "openrouter", model: "anthropic/claude-sonnet-5" });
  });

  it("refuses a local provider, llama-server or a server on this machine", () => {
    withProviders();
    expect(parseTurnModel({ provider_id: "local-llama", provider_model: "x.gguf" })).toMatch(/shared by all projects/);
    expect(parseTurnModel({ provider_id: "lmstudio", provider_model: "llama" })).toMatch(/shared by all projects/);
  });

  it("refuses half a pair, an unknown provider and an empty model", () => {
    withProviders();
    expect(parseTurnModel({ provider_model: "openai/gpt-5" })).toMatch(/needs provider_id/);
    expect(parseTurnModel({ provider_id: "openrouter" })).toMatch(/needs provider_model/);
    expect(parseTurnModel({ provider_id: "gone", provider_model: "m" })).toMatch(/not configured/);
    expect(parseTurnModel({ provider_id: "openrouter", provider_model: "  " })).toMatch(/must be a model id/);
  });
});
