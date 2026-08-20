import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";

describe("llm-config", () => {
  it("parses config.llm.providers and bumps version to current", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openai/gpt-4o-mini",
          },
        ],
      },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.llm?.activeTextProvider).toBe("openrouter");
    expect(parsed.llm?.providers).toHaveLength(2);
  });

  it("accepts aimlapi as a first-class provider kind", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "aimlapi",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "aimlapi",
            kind: "aimlapi",
            defaultChatModel: "openai/gpt-5-2",
          },
        ],
      },
    });
    expect(parsed.llm?.activeTextProvider).toBe("aimlapi");
    expect(parsed.llm?.providers.find((p) => p.id === "aimlapi")).toMatchObject(
      { kind: "aimlapi", defaultChatModel: "openai/gpt-5-2" },
    );
  });

  it("accepts gemini as a first-class provider kind", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "gemini",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "gemini",
            kind: "gemini",
            defaultChatModel: "gemini-2.5-flash",
          },
        ],
      },
    });

    expect(parsed.llm?.providers.find((p) => p.id === "gemini")).toMatchObject({
      kind: "gemini",
      defaultChatModel: "gemini-2.5-flash",
    });
  });

  it("accepts qwen-openai-compatible as an explicit compatibility provider", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "qwen",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "qwen",
            kind: "qwen-openai-compatible",
            baseUrl: "https://example.invalid",
            defaultChatModel: "qwen-test",
          },
        ],
      },
    });

    expect(parsed.llm?.providers.find((provider) => provider.id === "qwen")).toMatchObject({
      kind: "qwen-openai-compatible",
      baseUrl: "https://example.invalid",
      defaultChatModel: "qwen-test",
    });
  });

  const baseLlm = (fallback: unknown) => ({
    version: USER_CONFIG_VERSION,
    llm: {
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto" as const,
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
        { id: "groq", kind: "openai-compatible", defaultChatModel: "llama-3.3" },
      ],
      fallback,
    },
  });

  it("parses a valid fallback chain and timing overrides", () => {
    const parsed = parseUserConfigFile(
      baseLlm({
        chain: ["openrouter", "groq"],
        appendLocal: true,
        failureThreshold: 3,
        cooldownMs: [30000, 60000, 300000],
      }),
    );
    expect(parsed.llm?.fallback).toMatchObject({
      chain: ["openrouter", "groq"],
      appendLocal: true,
      failureThreshold: 3,
      cooldownMs: [30000, 60000, 300000],
    });
  });

  it("rejects a fallback chain id that is not a configured provider", () => {
    expect(() =>
      parseUserConfigFile(baseLlm({ chain: ["openrouter", "ghost"] })),
    ).toThrow(/llm\.fallback\.chain\[1\]/);
  });

  it("rejects a non-positive failureThreshold", () => {
    expect(() =>
      parseUserConfigFile(baseLlm({ chain: ["openrouter"], failureThreshold: 0 })),
    ).toThrow(/failureThreshold/);
  });

  it("rejects an empty cooldown ladder", () => {
    expect(() =>
      parseUserConfigFile(baseLlm({ chain: ["openrouter"], cooldownMs: [] })),
    ).toThrow(/cooldownMs/);
  });

  it("rejects a decreasing cooldown ladder (must escalate)", () => {
    expect(() =>
      parseUserConfigFile(
        baseLlm({ chain: ["openrouter"], cooldownMs: [300000, 1000] }),
      ),
    ).toThrow(/non-decreasing/);
  });

  it("accepts a flat (equal-step) cooldown ladder", () => {
    const parsed = parseUserConfigFile(
      baseLlm({ chain: ["openrouter"], cooldownMs: [30000, 30000] }),
    );
    expect(parsed.llm?.fallback).toMatchObject({
      cooldownMs: [30000, 30000],
    });
  });

  it("rejects a non-boolean appendLocal", () => {
    expect(() =>
      parseUserConfigFile(baseLlm({ chain: ["openrouter"], appendLocal: "yes" })),
    ).toThrow(/appendLocal/);
  });

  it("omits fallback entirely when not configured", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
          { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
        ],
      },
    });
    expect(parsed.llm?.fallback).toBeUndefined();
  });

  it("parses extraBody on an openai-compatible provider entry", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "model-studio",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "model-studio",
            kind: "qwen-openai-compatible",
            baseUrl: "https://example.invalid/compatible-mode",
            defaultChatModel: "qwen3.8-27b",
            extraBody: { chat_template_kwargs: { enable_thinking: false } },
          },
        ],
      },
    });
    expect(parsed.llm?.providers[1]?.extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  const withProviderField = (extra: Record<string, unknown>) => ({
    version: USER_CONFIG_VERSION,
    llm: {
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto" as const,
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt", ...extra },
      ],
    },
  });

  it("round-trips promptCache and providerPreferences on a provider entry", () => {
    const parsed = parseUserConfigFile(
      withProviderField({
        promptCache: "explicit-markers",
        providerPreferences: { order: ["anthropic"], allow_fallbacks: false },
      }),
    );
    expect(parsed.llm?.providers[1]).toMatchObject({
      promptCache: "explicit-markers",
      providerPreferences: { order: ["anthropic"], allow_fallbacks: false },
    });
  });

  it("rejects an unknown promptCache mode", () => {
    expect(() =>
      parseUserConfigFile(withProviderField({ promptCache: "always" })),
    ).toThrow(/llm\.providers\[1\]\.promptCache/);
  });

  it("rejects a non-object providerPreferences", () => {
    expect(() =>
      parseUserConfigFile(withProviderField({ providerPreferences: ["anthropic"] })),
    ).toThrow(/llm\.providers\[1\]\.providerPreferences/);
  });

  const withUserModels = (userModels: unknown) => ({
    version: USER_CONFIG_VERSION,
    llm: {
      activeTextProvider: "model-studio",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto" as const,
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        {
          id: "model-studio",
          kind: "qwen-openai-compatible",
          baseUrl: "https://example.invalid/compatible-mode",
          defaultChatModel: "qwen3.8-27b",
          userModels,
        },
      ],
    },
  });

  it("round-trips userModels on a provider entry", () => {
    const parsed = parseUserConfigFile(
      withUserModels([
        {
          id: "qwen3.8-27b",
          kind: "chat",
          contextWindow: 262144,
          supportsVision: true,
          supportsTools: "strict",
          supportsPromptCache: true,
          reasoningFormat: "delta_reasoning_content",
          pricing: { input: 0.0004, output: 0.0012, cacheRead: 0 },
        },
        { id: "text-embedding-v4", kind: "embedding", dim: 1024 },
      ]),
    );

    // resolveModel reads userModels as its highest-priority source, so
    // the parser dropping these rows is the difference between a
    // hand-configured model and the 128k/no-pricing defaults.
    expect(parsed.llm?.providers[1]?.userModels).toEqual([
      {
        id: "qwen3.8-27b",
        kind: "chat",
        contextWindow: 262144,
        dim: undefined,
        supportsVision: true,
        supportsTools: "strict",
        supportsPromptCache: true,
        reasoningFormat: "delta_reasoning_content",
        pricing: { input: 0.0004, output: 0.0012, cacheRead: 0 },
      },
      {
        id: "text-embedding-v4",
        kind: "embedding",
        contextWindow: undefined,
        dim: 1024,
        supportsVision: undefined,
        supportsTools: undefined,
        supportsPromptCache: undefined,
        reasoningFormat: undefined,
        pricing: undefined,
      },
    ]);
  });

  it("omits userModels when the entry does not configure any", () => {
    const parsed = parseUserConfigFile(withUserModels(undefined));
    expect(parsed.llm?.providers[1]?.userModels).toBeUndefined();
  });

  it("rejects a userModels row with an unknown kind", () => {
    expect(() =>
      parseUserConfigFile(
        withUserModels([{ id: "qwen3.8-27b", kind: "completion" }]),
      ),
    ).toThrow(/llm\.providers\[1\]\.userModels\[0\]\.kind/);
  });

  it("rejects a userModels row with a malformed contextWindow", () => {
    expect(() =>
      parseUserConfigFile(
        withUserModels([
          { id: "a", kind: "chat" },
          { id: "b", kind: "chat", contextWindow: "262144" },
        ]),
      ),
    ).toThrow(/llm\.providers\[1\]\.userModels\[1\]\.contextWindow/);
  });

  it("rejects userModels pricing that is missing a rate", () => {
    expect(() =>
      parseUserConfigFile(
        withUserModels([
          { id: "a", kind: "chat", pricing: { input: 0.0004 } },
        ]),
      ),
    ).toThrow(/llm\.providers\[1\]\.userModels\[0\]\.pricing\.output/);
  });

  it("rejects duplicate model ids within one provider's userModels", () => {
    expect(() =>
      parseUserConfigFile(
        withUserModels([
          { id: "a", kind: "chat" },
          { id: "a", kind: "chat" },
        ]),
      ),
    ).toThrow(/userModels\[1\]\.id/);
  });

  it("rejects a non-array userModels", () => {
    expect(() =>
      parseUserConfigFile(withUserModels({ "qwen3.8-27b": { kind: "chat" } })),
    ).toThrow(/userModels/);
  });

  it("rejects a non-object extraBody", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "model-studio",
          activeEmbeddingProvider: "local-llama",
          toolTransport: "auto",
          providers: [
            {
              id: "local-llama",
              kind: "llama-server",
              url: "http://127.0.0.1:19091",
            },
            {
              id: "model-studio",
              kind: "qwen-openai-compatible",
              baseUrl: "https://example.invalid/compatible-mode",
              defaultChatModel: "qwen3.8-27b",
              extraBody: "enable_thinking=false",
            },
          ],
        },
      }),
    ).toThrow(/extraBody/);
  });
});
