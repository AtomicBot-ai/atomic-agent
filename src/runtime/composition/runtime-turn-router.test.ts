import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { routeTurnProvider } from "./runtime-turn-router.js";
import { createCompactionDefaults } from "../../config/agent/compaction-config.js";
import { EMPTY_CONTEXT_USAGE } from "../../session/context-usage.js";
import { localFirstSessionSize } from "./local-first-fit.js";
import { createLocalFirstWindowResolver } from "../local-first-window.js";

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
    agent: { compaction: createCompactionDefaults(), conversationMaxTokens: 0 },
    localModels: { completionMaxTokens: 4096, thinking: "off", reasoningBudgetTokens: 0, mode: "external", managed: { contextSize: 0 } },
    paths: { localModelsDataDir: "/nonexistent/models" },
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
      sessionSize: { historyTokens: 90_000, fixedTokens: 10_000 },
      localContextWindow: () => 16_384,
    });
    expect(providerId).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ historyTokens: 90_000, fixedTokens: 10_000 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
  });

  it("a session that fits the local window still starts on it", () => {
    expect(
      run(localFirstConfig({ localFirst: true }), {
        ...available,
        sessionSize: { historyTokens: 2_000, fixedTokens: 2_000 },
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

  it("tells the caller when the local-first cascade heads the turn, not a router rule (ATO-2434)", () => {
    const onLocalFirstHead = vi.fn();
    run(localFirstConfig({ localFirst: true }), { ...available, onLocalFirstHead });
    expect(onLocalFirstHead).toHaveBeenCalledWith("local-llama");
    onLocalFirstHead.mockClear();
    const ruled = localFirstConfig({ localFirst: true }, { enabled: true, rules: [{ provider: "groq" }] });
    run(ruled, { ...available, onLocalFirstHead });
    expect(onLocalFirstHead).not.toHaveBeenCalled();
  });

  it("checks history against the local allowance, not the whole prompt against the window", () => {
    // 32k window: 12k fixed + 16k history is a 28k prompt, under 0.9 of
    // the window, but the history allowance is about 16k and compaction
    // fires at 0.9 of that.
    expect(
      run(localFirstConfig({ localFirst: true }), {
        ...available,
        sessionSize: { historyTokens: 16_000, fixedTokens: 12_000 },
        localContextWindow: () => 32_768,
      }).providerId,
    ).toBeUndefined();
  });

  it("right after a restart (no live window, no catalogue window) a long resumed session stays in the cloud", () => {
    const config = localFirstConfig({ localFirst: true });
    // Wired as bootstrap wires it: the live profile is not read yet and
    // a llama-server link has no catalogue entry.
    const localContextWindow = createLocalFirstWindowResolver({
      liveWindow: () => undefined,
      catalogWindow: () => null,
      readConfig: () => config,
    });
    const usage = {
      ...EMPTY_CONTEXT_USAGE,
      tokens: 100_000,
      conversationTokens: 88_000,
      sections: [
        { label: "prompt scaffold", tokens: 12_000 },
        { label: "conversation", tokens: 88_000 },
      ],
    };
    const resumed = run(config, {
      ...available,
      sessionSize: localFirstSessionSize(usage, "next question"),
      localContextWindow,
    });
    expect(resumed.providerId).toBeUndefined();
    // A short session still starts local with the window unknown.
    const short = run(config, {
      ...available,
      sessionSize: localFirstSessionSize(
        { ...usage, tokens: 6_000, conversationTokens: 2_000, sections: [{ label: "prompt scaffold", tokens: 4_000 }, { label: "conversation", tokens: 2_000 }] },
        "hi",
      ),
      localContextWindow,
    });
    expect(short.providerId).toBe("local-llama");
  });

  it("a matching router rule wins over the local-first head", () => {
    const config = localFirstConfig({ localFirst: true }, { enabled: true, rules: [{ provider: "groq" }] });
    expect(run(config, available).providerId).toBe("groq");
  });
});
