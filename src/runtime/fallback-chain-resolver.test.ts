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
});
