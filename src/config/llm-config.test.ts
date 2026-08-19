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
  it("accepts subscription-cli entries and round-trips subscriptionCli", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "claude-cli",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "claude-cli",
            kind: "subscription-cli",
            defaultChatModel: "sonnet",
            subscriptionCli: {
              cli: "claude",
              binPath: "/opt/homebrew/bin/claude",
              extraArgs: ["--effort", "high"],
              streaming: false,
              maxBudgetUsd: 5,
            },
          },
        ],
      },
    });
    const entry = parsed.llm?.providers.find((p) => p.id === "claude-cli");
    // parseLlmProviderEntry is a whitelist that rebuilds the entry from
    // known keys, so an unparsed field would be silently dropped on the
    // next config rewrite. Pin the whole block, not just `cli`.
    expect(entry?.subscriptionCli).toEqual({
      cli: "claude",
      binPath: "/opt/homebrew/bin/claude",
      extraArgs: ["--effort", "high"],
      streaming: false,
      maxBudgetUsd: 5,
    });
  });

  it("rejects a subscription-cli entry with no subscriptionCli block", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "claude-cli",
          activeEmbeddingProvider: "claude-cli",
          toolTransport: "auto",
          providers: [{ id: "claude-cli", kind: "subscription-cli" }],
        },
      }),
    ).toThrow(/subscriptionCli/);
  });

  it("rejects an unknown cli name", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "gemini-cli",
          activeEmbeddingProvider: "gemini-cli",
          toolTransport: "auto",
          providers: [
            {
              id: "gemini-cli",
              kind: "subscription-cli",
              subscriptionCli: { cli: "gemini" },
            },
          ],
        },
      }),
    ).toThrow(/subscriptionCli\.cli/);
  });

  it("rejects non-string extraArgs", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "claude-cli",
          activeEmbeddingProvider: "claude-cli",
          toolTransport: "auto",
          providers: [
            {
              id: "claude-cli",
              kind: "subscription-cli",
              subscriptionCli: { cli: "claude", extraArgs: ["--effort", 3] },
            },
          ],
        },
      }),
    ).toThrow(/extraArgs\[1\]/);
  });
});
