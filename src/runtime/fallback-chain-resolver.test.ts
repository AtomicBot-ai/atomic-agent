import { describe, expect, it, vi } from "vitest";

import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { createFallbackChainResolver } from "./fallback-chain-resolver.js";

function llm(providers: ResolvedLlmConfig["providers"]): ResolvedLlmConfig {
  return {
    activeTextProvider: providers[0]!.id,
    activeEmbeddingProvider: providers[0]!.id,
    providers,
    toolTransport: "auto",
    fallback: { chain: providers.map((p) => p.id) },
  };
}

describe("createFallbackChainResolver", () => {
  const config = llm([
    { id: "openrouter", kind: "openrouter", apiKey: "sk-or" },
    { id: "ollama", kind: "openai-compatible" },
    { id: "local-llama", kind: "llama-server" },
  ]);

  it("takes the configured chain as is until the registry exists", () => {
    const resolve = createFallbackChainResolver({
      readLlmConfig: () => config,
      builtProviderIds: () => null,
      logger: { warn: vi.fn() },
    });
    expect(resolve().chain).toEqual(["openrouter", "ollama", "local-llama"]);
  });

  it("drops a link the registry did not build, and says so once", () => {
    const warn = vi.fn();
    const resolve = createFallbackChainResolver({
      readLlmConfig: () => config,
      builtProviderIds: () => ["openrouter", "local-llama"],
      logger: { warn },
    });
    expect(resolve().chain).toEqual(["openrouter", "local-llama"]);
    expect(resolve().chain).toEqual(["openrouter", "local-llama"]);
    expect(warn.mock.calls).toEqual([
      ["llm: fallback link skipped (provider not built)", { id: "ollama" }],
    ]);
  });

  describe("a fallback link with no key", () => {
    const field = (dashscopeKey?: string): ResolvedLlmConfig => ({
      activeTextProvider: "aimlapi",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      providers: [
        { id: "aimlapi", kind: "aimlapi", apiKey: "sk-aiml" },
        {
          id: "dashscope",
          kind: "openai-compatible",
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
          defaultChatModel: "qwen-plus",
          ...(dashscopeKey ? { apiKey: dashscopeKey } : {}),
        },
        { id: "local-llama", kind: "llama-server" },
      ],
      fallback: { chain: ["dashscope"] },
    });

    it("is skipped and logged as skipped, once", () => {
      const warn = vi.fn();
      const resolve = createFallbackChainResolver({
        readLlmConfig: () => field(),
        builtProviderIds: () => ["aimlapi", "dashscope", "local-llama"],
        logger: { warn },
      });
      expect(resolve().chain).toEqual(["aimlapi", "local-llama"]);
      expect(resolve().chain).toEqual(["aimlapi", "local-llama"]);
      expect(warn.mock.calls).toEqual([
        ["llm: fallback link skipped (no key)", { id: "dashscope" }],
      ]);
    });

    it("comes back the moment a key is saved, and is reported again if it loses it", () => {
      const warn = vi.fn();
      let config = field();
      const resolve = createFallbackChainResolver({
        readLlmConfig: () => config,
        builtProviderIds: () => null,
        logger: { warn },
      });
      expect(resolve().chain).toEqual(["aimlapi", "local-llama"]);
      config = field("sk-dash");
      expect(resolve().chain).toEqual(["aimlapi", "dashscope", "local-llama"]);
      config = field();
      expect(resolve().chain).toEqual(["aimlapi", "local-llama"]);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("is never the primary: a keyless active provider is still asked", () => {
      const warn = vi.fn();
      const resolve = createFallbackChainResolver({
        readLlmConfig: () => ({ ...field(), activeTextProvider: "dashscope" }),
        builtProviderIds: () => null,
        logger: { warn },
      });
      expect(resolve().chain[0]).toBe("dashscope");
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
