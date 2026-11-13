import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";

describe("resolveLlmProviderApiKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves Gemini keys from GEMINI_API_KEY", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

    expect(resolveLlmProviderApiKey({ id: "gemini", kind: "gemini" })).toBe(
      "gemini-test-key",
    );
  });
});

describe("resolveLlmProviderApiKey for a server on another computer (ATO-1066)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never sends the shared OpenAI key to a LAN address", () => {
    // Unset, not empty: an empty OPENAI_COMPAT_API_KEY would win the `??`
    // chain and hide the leak this test is about.
    const saved = {
      OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY,
      ATOMIC_AGENT_OPENAI_API_KEY: process.env.ATOMIC_AGENT_OPENAI_API_KEY,
    };
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.ATOMIC_AGENT_OPENAI_API_KEY;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[name] = value;
      }
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "custom-192-168-1-20-8080",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
      }),
    ).toBeUndefined();
  });

  it("still uses the LAN entry's own key or key variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ATOMIC_AGENT_KEY_LAN", "lan-key");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKey: "stored",
      }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_LAN",
      }),
    ).toBe("lan-key");
  });

  it("keeps the shared fallback for a cloud endpoint", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "openai-compatible",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe("sk-test");
  });
});
