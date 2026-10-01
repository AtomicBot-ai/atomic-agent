import { describe, expect, it } from "vitest";

import type { LlmProviderConfigEntry } from "../provider/registry/provider-types.js";
import { lacksRequiredApiKey } from "./missing-api-key.js";

const DASHSCOPE: LlmProviderConfigEntry = {
  id: "dashscope",
  kind: "openai-compatible",
  baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
  defaultChatModel: "qwen-plus",
};

describe("lacksRequiredApiKey", () => {
  it("is a cloud preset entry with no key: the field case (a desktop import drops keys)", () => {
    expect(lacksRequiredApiKey(DASHSCOPE)).toBe(true);
    // A numbered second entry of the same preset is the same service.
    expect(lacksRequiredApiKey({ ...DASHSCOPE, id: "dashscope-2" })).toBe(true);
    expect(
      lacksRequiredApiKey({
        id: "anthropic",
        kind: "openai-compatible",
        baseUrl: "https://api.anthropic.com",
        apiKeyHeader: "x-api-key",
        headers: { "anthropic-version": "2023-06-01" },
      }),
    ).toBe(true);
  });

  it("is a cloud kind on its own endpoint with no key", () => {
    expect(lacksRequiredApiKey({ id: "openrouter", kind: "openrouter" })).toBe(true);
    expect(lacksRequiredApiKey({ id: "aimlapi", kind: "aimlapi" })).toBe(true);
    expect(lacksRequiredApiKey({ id: "gemini", kind: "gemini" })).toBe(true);
  });

  it("is not an entry that has a key, in the key field or a header set by hand", () => {
    expect(lacksRequiredApiKey({ ...DASHSCOPE, apiKey: "sk-test" })).toBe(false);
    expect(
      lacksRequiredApiKey({ id: "openrouter", kind: "openrouter", apiKey: "sk-or" }),
    ).toBe(false);
    expect(
      lacksRequiredApiKey({
        ...DASHSCOPE,
        headers: { Authorization: "Bearer sk-test" },
      }),
    ).toBe(false);
    expect(
      lacksRequiredApiKey({
        id: "anthropic",
        kind: "openai-compatible",
        baseUrl: "https://api.anthropic.com",
        apiKeyHeader: "x-api-key",
        headers: { "X-Api-Key": "sk-ant-test" },
      }),
    ).toBe(false);
  });

  it("is never a server that may need no key", () => {
    // Local presets: no key exists at all.
    for (const id of ["lmstudio", "ollama", "atomic-chat"]) {
      expect(
        lacksRequiredApiKey({
          id,
          kind: "openai-compatible",
          baseUrl: "http://192.168.1.20:1234",
        }),
      ).toBe(false);
    }
    // A hand-made entry: nothing says what it points at.
    expect(
      lacksRequiredApiKey({
        id: "my-vllm",
        kind: "openai-compatible",
        baseUrl: "https://vllm.lan.example",
      }),
    ).toBe(false);
    // A cloud preset id pointed elsewhere (a proxy that holds the key).
    expect(
      lacksRequiredApiKey({ ...DASHSCOPE, baseUrl: "http://127.0.0.1:4000" }),
    ).toBe(false);
    // A cloud kind behind an overridden endpoint.
    expect(
      lacksRequiredApiKey({
        id: "openrouter",
        kind: "openrouter",
        baseUrl: "http://127.0.0.1:4000",
      }),
    ).toBe(false);
    expect(lacksRequiredApiKey({ id: "local-llama", kind: "llama-server" })).toBe(
      false,
    );
    expect(
      lacksRequiredApiKey({
        id: "claude-cli",
        kind: "subscription-cli",
        subscriptionCli: { cli: "claude" },
      }),
    ).toBe(false);
  });
});
