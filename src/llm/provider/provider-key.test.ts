import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  providerKeyMissing,
  providerKeyStatus,
  type ProviderKeySubject,
} from "./provider-key.js";

/** Every variable `resolveLlmProviderApiKey` can read for these fixtures. */
const KEY_ENV = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
  "GROQ_API_KEY",
  "LMSTUDIO_API_KEY",
  "MY_LLM_KEY",
] as const;

beforeEach(() => {
  for (const name of KEY_ENV) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const GROQ: ProviderKeySubject = {
  id: "groq",
  kind: "openai-compatible",
  baseUrl: "https://api.groq.com/openai",
  apiKeyEnvVar: "GROQ_API_KEY",
};

const LMSTUDIO: ProviderKeySubject = {
  id: "lmstudio",
  kind: "openai-compatible",
  baseUrl: "http://localhost:1234",
  apiKeyEnvVar: "LMSTUDIO_API_KEY",
};

describe("providerKeyStatus", () => {
  it("is present when a key resolves, from the entry or its env var", () => {
    expect(providerKeyStatus({ ...GROQ, apiKey: "gsk-x" }).state).toBe("present");
    vi.stubEnv("GROQ_API_KEY", "gsk-env");
    expect(providerKeyStatus(GROQ).state).toBe("present");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    expect(providerKeyStatus({ id: "openrouter", kind: "openrouter" }).state).toBe(
      "present",
    );
  });

  it("reads only the entry's own key with keyFrom: entry", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    const bare = { id: "openrouter", kind: "openrouter" };
    expect(providerKeyStatus(bare, { keyFrom: "entry" }).state).toBe("missing");
    expect(
      providerKeyStatus({ ...bare, apiKey: "sk-or" }, { keyFrom: "entry" }).state,
    ).toBe("present");
  });

  it("counts a credential header set by hand, and not an empty one", () => {
    expect(
      providerKeyStatus({ ...GROQ, headers: { Authorization: "Bearer gsk-x" } })
        .state,
    ).toBe("present");
    expect(
      providerKeyStatus({
        id: "anthropic",
        kind: "openai-compatible",
        baseUrl: "https://api.anthropic.com",
        apiKeyHeader: "x-api-key",
        headers: { "X-Api-Key": "sk-ant" },
      }).state,
    ).toBe("present");
    expect(
      providerKeyStatus({ ...GROQ, headers: { Authorization: " " } }),
    ).toEqual({ state: "missing", envVar: "GROQ_API_KEY" });
  });

  it("is missing for a cloud kind on its own endpoint", () => {
    for (const kind of ["openrouter", "aimlapi", "gemini"]) {
      expect(providerKeyStatus({ id: kind, kind })).toEqual({
        state: "missing",
        envVar: null,
      });
    }
  });

  it("is missing for an entry that declares an env var that is unset", () => {
    expect(providerKeyStatus(GROQ)).toEqual({
      state: "missing",
      envVar: "GROQ_API_KEY",
    });
    // A hand-made entry that says where its key lives has said it needs one.
    expect(
      providerKeyStatus({
        id: "my-llm",
        kind: "openai-compatible",
        baseUrl: "https://llm.example.com",
        apiKeyEnvVar: "MY_LLM_KEY",
      }),
    ).toEqual({ state: "missing", envVar: "MY_LLM_KEY" });
  });

  it("is missing for a cloud preset entry still on the preset's host", () => {
    expect(
      providerKeyStatus({
        id: "dashscope-2",
        kind: "openai-compatible",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
      }),
    ).toEqual({ state: "missing", envVar: null });
  });

  it("is not-needed for a local server, whatever env var it declares", () => {
    expect(providerKeyStatus(LMSTUDIO).state).toBe("not-needed");
    // A local preset on a LAN address is still a keyless server.
    expect(
      providerKeyStatus({ ...LMSTUDIO, id: "ollama", baseUrl: "http://192.168.1.20:11434" })
        .state,
    ).toBe("not-needed");
    // Any entry pointed at this machine, cloud kinds included.
    expect(
      providerKeyStatus({
        id: "openrouter",
        kind: "openrouter",
        baseUrl: "http://127.0.0.1:4000",
      }).state,
    ).toBe("not-needed");
    expect(
      providerKeyStatus({
        id: "claude-cli",
        kind: "subscription-cli",
        subscriptionCli: { cli: "claude" },
      }).state,
    ).toBe("not-needed");
  });

  it("is unverified when nothing says a key is needed", () => {
    expect(
      providerKeyStatus({
        id: "my-vllm",
        kind: "openai-compatible",
        baseUrl: "https://vllm.lan.example",
      }).state,
    ).toBe("unverified");
    // A cloud kind behind an overridden endpoint: a proxy may hold the key.
    expect(
      providerKeyStatus({
        id: "openrouter",
        kind: "openrouter",
        baseUrl: "https://proxy.example.com",
      }).state,
    ).toBe("unverified");
    // A cloud preset id repointed elsewhere, declaring no env var.
    expect(
      providerKeyStatus({
        id: "dashscope",
        kind: "openai-compatible",
        baseUrl: "https://proxy.example.com",
      }).state,
    ).toBe("unverified");
    expect(
      providerKeyStatus({ id: "remote-box", kind: "llama-server" }).state,
    ).toBe("unverified");
  });

  it("providerKeyMissing is true only for missing", () => {
    expect(providerKeyMissing(GROQ)).toBe(true);
    expect(providerKeyMissing(LMSTUDIO)).toBe(false);
    expect(providerKeyMissing({ id: "my-vllm", kind: "openai-compatible", baseUrl: "https://vllm.lan.example" })).toBe(false);
  });
});
