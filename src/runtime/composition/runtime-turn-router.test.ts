import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { routeTurnProvider, sessionPromptEstimate } from "./runtime-turn-router.js";
import { estimateTokens } from "../../prompt/token-budget.js";

function configWith(router: unknown): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "openrouter",
      toolTransport: "auto",
      providers: [
        { id: "openrouter", kind: "openrouter" },
        { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" },
        { id: "unbuilt", kind: "openai-compatible" },
      ],
      ...(router === undefined ? {} : { router }),
    },
  } as unknown as AtomicAgentConfig;
}

function run(config: AtomicAgentConfig, overrides: Partial<Parameters<typeof routeTurnProvider>[0]> = {}) {
  const info = vi.fn();
  const providerId = routeTurnProvider({
    config,
    userMessage: "hi",
    workingDir: "/tmp/project",
    pinnedProviderId: undefined,
    runMode: { stored: null, effective: "cloud" },
    isRegistered: (id) => id !== "unbuilt",
    logger: { info },
    sessionId: "s1",
    ...overrides,
  });
  return { providerId, info };
}

describe("routeTurnProvider (ATO-483)", () => {
  it("leaves the turn alone when the router is not configured or is off", () => {
    expect(run(configWith(undefined)).providerId).toBeUndefined();
    expect(run(configWith({ enabled: false, rules: [{ provider: "groq" }] })).providerId).toBeUndefined();
  });

  it("returns the rule's provider and logs the rule, not the message", () => {
    const { providerId, info } = run(
      configWith({ enabled: true, rules: [{ name: "short", when: { maxTokens: 5 }, provider: "groq" }] }),
      { userMessage: "hi" },
    );
    expect(providerId).toBe("groq");
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).toContain("short");
    expect(JSON.stringify(info.mock.calls)).not.toContain('"hi"');
  });

  it("skips a provider the registry did not build", () => {
    const { providerId } = run(
      configWith({ enabled: true, rules: [{ provider: "unbuilt" }, { provider: "groq" }] }),
    );
    expect(providerId).toBe("groq");
  });

  it("does nothing under Fusion, the local run mode, or a pinned turn", () => {
    const config = configWith({ enabled: true, rules: [{ provider: "groq" }] });
    expect(run(config, { runMode: { stored: "fusion", effective: "fusion" } }).providerId).toBeUndefined();
    expect(run(config, { runMode: { stored: "local", effective: "local" } }).providerId).toBeUndefined();
    expect(run(config, { pinnedProviderId: "openrouter" }).providerId).toBeUndefined();
  });

  it("still routes under the stored cloud run mode", () => {
    const config = configWith({ enabled: true, rules: [{ provider: "groq" }] });
    expect(run(config, { runMode: { stored: "cloud", effective: "cloud" } }).providerId).toBe("groq");
  });
});

function localFirstConfig(fallback: unknown, router?: unknown): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "openrouter",
      toolTransport: "auto",
      providers: [
        { id: "openrouter", kind: "openrouter" },
        { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" },
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      ],
      ...(fallback === undefined ? {} : { fallback }),
      ...(router === undefined ? {} : { router }),
    },
  } as unknown as AtomicAgentConfig;
}

describe("routeTurnProvider local-first cascade (ATO-2208)", () => {
  const available = { linkUnavailable: () => false };

  it("starts the turn on the local provider when llm.fallback.localFirst is on", () => {
    const { providerId, info } = run(localFirstConfig({ localFirst: true }), {
      ...available,
      userMessage: "a secret question",
    });
    expect(providerId).toBe("local-llama");
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
  });

  it("leaves the turn alone when localFirst is unset or false", () => {
    expect(run(localFirstConfig(undefined), available).providerId).toBeUndefined();
    expect(run(localFirstConfig({ localFirst: false }), available).providerId).toBeUndefined();
  });

  it("leaves the turn alone when the local model is not on disk", () => {
    expect(
      run(localFirstConfig({ localFirst: true }), { linkUnavailable: () => true }).providerId,
    ).toBeUndefined();
  });

  it("does nothing under Fusion or a pinned turn", () => {
    const config = localFirstConfig({ localFirst: true });
    expect(
      run(config, { ...available, runMode: { stored: "fusion", effective: "fusion" } }).providerId,
    ).toBeUndefined();
    expect(run(config, { ...available, pinnedProviderId: "openrouter" }).providerId).toBeUndefined();
  });

  it("keeps a session too long for the local window in the cloud, and says why (ATO-2537)", () => {
    const { providerId, info } = run(localFirstConfig({ localFirst: true }), {
      ...available,
      userMessage: "a secret question",
      sessionPromptTokens: 100_000,
      localContextWindow: () => 16_384,
    });
    expect(providerId).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ promptTokens: 100_000 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
  });

  it("a session that fits the local window still starts on it", () => {
    expect(
      run(localFirstConfig({ localFirst: true }), {
        ...available,
        sessionPromptTokens: 4_000,
        localContextWindow: () => 16_384,
      }).providerId,
    ).toBe("local-llama");
  });

  it("keeps the turn in the cloud while the local model rests after a failure (ATO-2435)", () => {
    const { providerId, info } = run(localFirstConfig({ localFirst: true }), {
      ...available,
      isCoolingDown: (id) => id === "local-llama",
    });
    expect(providerId).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("rests");
  });

  it("a matching router rule wins over the local-first head", () => {
    const config = localFirstConfig({ localFirst: true }, { enabled: true, rules: [{ provider: "groq" }] });
    expect(run(config, available).providerId).toBe("groq");
  });
});

describe("sessionPromptEstimate (ATO-2537)", () => {
  it("adds the new message to the last prompt's size", () => {
    expect(sessionPromptEstimate(50_000, "hello there")).toBe(50_000 + estimateTokens("hello there"));
  });

  it("is unknown when no prompt was built yet", () => {
    expect(sessionPromptEstimate(null, "hi")).toBeNull();
    expect(sessionPromptEstimate(undefined, "hi")).toBeNull();
    expect(sessionPromptEstimate(0, "hi")).toBeNull();
  });
});
