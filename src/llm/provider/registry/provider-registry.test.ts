import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  registerProviderKind,
  resolveLlmConfig,
  knownProviderKinds,
} from "./provider-registry.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { GeminiProvider } from "../gemini/gemini-provider.js";

describe("ProviderRegistry", () => {
  it("registers built-in kinds", () => {
    registerBuiltInProviderKinds();
    const kinds = knownProviderKinds();
    expect(kinds).toContain("llama-server");
    expect(kinds).toContain("openai-compatible");
    expect(kinds).toContain("qwen-openai-compatible");
    expect(kinds).toContain("openrouter");
    expect(kinds).toContain("gemini");
    expect(kinds).toContain("subscription-cli");
  });

  it("resolveLlmConfig synthesizes local-llama when llm block absent", () => {
    const cfg = getConfig();
    const resolved = resolveLlmConfig(cfg);
    expect(resolved.activeTextProvider).toBe("local-llama");
    expect(resolved.providers[0]?.kind).toBe("llama-server");
    expect(resolved.toolTransport).toBe("auto");
  });

  it("constructs Gemini through the built-in registry factory", async () => {
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "gemini",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [
          {
            id: "gemini",
            kind: "gemini",
            apiKey: "test-key",
          },
        ],
      },
    } as AtomicAgentConfig;

    const registry = await ProviderRegistry.fromConfig(fakeConfig, {
      config: fakeConfig,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
    });

    expect(registry.activeText).toBeInstanceOf(GeminiProvider);
  });

  it("rejects unknown provider kind at fromConfig", async () => {
    registerBuiltInProviderKinds();
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "bad",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [{ id: "bad", kind: "nonexistent-kind" }],
      },
    } as AtomicAgentConfig;
    await expect(
      ProviderRegistry.fromConfig(fakeConfig, {
        config: fakeConfig,
        llamaClient: {} as never,
        getProfile: () => ({}) as never,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as never,
      }),
    ).rejects.toThrow(/unknown llm provider kind/);
  });

  it("allows embedding-only openai-compatible provider without defaultChatModel", async () => {
    registerBuiltInProviderKinds();
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "chat-provider",
        activeEmbeddingProvider: "embed-only",
        toolTransport: "auto" as const,
        providers: [
          {
            id: "chat-provider",
            kind: "openai-compatible",
            baseUrl: "https://example.invalid",
            defaultChatModel: "gpt-4",
          },
          {
            id: "embed-only",
            kind: "openai-compatible",
            baseUrl: "https://example.invalid",
            defaultEmbeddingModel: "nomic-embed-text",
            userModels: [
              {
                id: "nomic-embed-text",
                kind: "embedding" as const,
                dim: 768,
              },
            ],
          },
        ],
      },
    } as AtomicAgentConfig;
    const registry = await ProviderRegistry.fromConfig(fakeConfig, {
      config: fakeConfig,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(registry.listIds()).toContain("embed-only");
  });

  it("rejects non-embedding openai-compatible provider without defaultChatModel", async () => {
    registerBuiltInProviderKinds();
    const fakeConfig = {
      ...getConfig(),
      llm: {
        activeTextProvider: "chat-provider",
        activeEmbeddingProvider: "embed-only",
        toolTransport: "auto" as const,
        providers: [
          {
            id: "chat-provider",
            kind: "openai-compatible",
            baseUrl: "https://example.invalid",
            defaultChatModel: "gpt-4",
          },
          {
            id: "bad-provider",
            kind: "openai-compatible",
            baseUrl: "https://example.invalid",
            userModels: [{ id: "gpt-4", kind: "chat" as const }],
          },
        ],
      },
    } as AtomicAgentConfig;
    await expect(
      ProviderRegistry.fromConfig(fakeConfig, {
        config: fakeConfig,
        llamaClient: {} as never,
        getProfile: () => ({}) as never,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/requires defaultChatModel/);
  });
});
