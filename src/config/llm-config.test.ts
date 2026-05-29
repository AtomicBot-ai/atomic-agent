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
});
