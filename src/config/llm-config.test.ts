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
});
