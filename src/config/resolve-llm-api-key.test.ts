import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  mayReceiveOpenAiKey,
  resolveExtraApiKeys,
  resolveLlmProviderApiKey,
} from "./resolve-llm-api-key.js";

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

describe("resolveLlmProviderApiKey: the OpenAI key only goes to OpenAI (ATO-1703)", () => {
  const SHARED = [
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_API_KEY",
    "ATOMIC_AGENT_OPENAI_API_KEY",
  ] as const;

  // Unset, not stubbed to "": an empty variable still wins the `??` chain
  // and would hide what each case is about.
  function withEnv(vars: Partial<Record<(typeof SHARED)[number], string>>): void {
    const saved = Object.fromEntries(SHARED.map((n) => [n, process.env[n]]));
    for (const name of SHARED) delete process.env[name];
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  }

  afterEach(() => vi.unstubAllEnvs());

  const compat = (baseUrl?: string) => ({
    id: "custom",
    kind: "openai-compatible" as const,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  it("does not send OPENAI_API_KEY to a server a config file named", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("https://api.openai.com.evil.example/v1"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("http://api.openai.com"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("not a url"))).toBeUndefined();
  });

  it("does not send ATOMIC_AGENT_OPENAI_API_KEY there either", () => {
    withEnv({ ATOMIC_AGENT_OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBeUndefined();
  });

  it("applies the same rule to the Qwen compat kind", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(
      resolveLlmProviderApiKey({
        id: "qwen",
        kind: "qwen-openai-compatible",
        baseUrl: "https://dashscope.example.com/compatible-mode",
      }),
    ).toBeUndefined();
  });

  it("still sends OPENAI_API_KEY to OpenAI, this machine, or the default endpoint", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://api.openai.com"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("https://API.openai.com/v1/"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("http://127.0.0.1:8080"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("http://localhost:1234/v1"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat())).toBe("sk-real");
  });

  it("keeps OPENAI_COMPAT_API_KEY working for any compat server", () => {
    withEnv({ OPENAI_COMPAT_API_KEY: "compat-key", OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBe("compat-key");
  });

  it("keeps the entry's own key and key variable first", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    vi.stubEnv("ATOMIC_AGENT_KEY_CUSTOM", "own-var");
    expect(
      resolveLlmProviderApiKey({ ...compat("https://llm.example.com"), apiKey: "stored" }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        ...compat("https://llm.example.com"),
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_CUSTOM",
      }),
    ).toBe("own-var");
  });
});

describe("mayReceiveOpenAiKey (ATO-1703)", () => {
  it("answers true only for OpenAI's API, literal loopback, or no address", () => {
    for (const url of [
      undefined,
      "",
      "https://api.openai.com/v1",
      "https://api.openai.com:443",
      "https://user:pass@api.openai.com",
      "http://[::1]:8080",
      "http://127.0.0.1:8080",
      "http://127.0.0.2:8080",
      "http://localhost:1234",
    ]) {
      expect(mayReceiveOpenAiKey(url), String(url)).toBe(true);
    }
    for (const url of [
      "https://api.openai.com:8443",
      "https://api.openai.com@evil.example",
      "https://api.openai.com./v1",
      "https://openai.com",
      "http://192.168.1.20:8080",
      "http://evil.localhost:8080",
      "http://0.0.0.0:8080",
      "ftp://127.0.0.1",
    ]) {
      expect(mayReceiveOpenAiKey(url), url).toBe(false);
    }
  });
});

describe("naming an OpenAI variable is no way around the rule (ATO-1703)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("apiKeyEnvVar: OPENAI_API_KEY only answers for OpenAI or this machine", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real");
    vi.stubEnv("ATOMIC_AGENT_OPENAI_API_KEY", "sk-real-2");
    const named = (baseUrl: string, apiKeyEnvVar = "OPENAI_API_KEY") => ({
      id: "x",
      kind: "openai-compatible" as const,
      baseUrl,
      apiKeyEnvVar,
    });
    expect(resolveLlmProviderApiKey(named("https://evil.example"))).toBeUndefined();
    expect(
      resolveLlmProviderApiKey(named("https://evil.example", "ATOMIC_AGENT_OPENAI_API_KEY")),
    ).toBeUndefined();
    expect(resolveLlmProviderApiKey(named("https://api.openai.com"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(named("http://127.0.0.1:8080"))).toBe("sk-real");
  });

  it("a native kind never reads the OpenAI variables through apiKeyEnvVar", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real");
    expect(
      resolveLlmProviderApiKey({ id: "or", kind: "openrouter", apiKeyEnvVar: "OPENAI_API_KEY" }),
    ).toBeUndefined();
  });

  it("extraApiKeyEnvVars follows the same rule, except for masking", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real");
    vi.stubEnv("ATOMIC_AGENT_KEY_SPARE", "spare");
    const entry = {
      kind: "openai-compatible",
      baseUrl: "https://evil.example",
      extraApiKeyEnvVars: ["OPENAI_API_KEY", "ATOMIC_AGENT_KEY_SPARE"],
    };
    expect(resolveExtraApiKeys(entry)).toEqual(["spare"]);
    expect(resolveExtraApiKeys({ ...entry, baseUrl: "https://api.openai.com" })).toEqual([
      "sk-real",
      "spare",
    ]);
    expect(resolveExtraApiKeys(entry, process.env, { scopeOpenAiKey: false })).toEqual([
      "sk-real",
      "spare",
    ]);
  });
});
