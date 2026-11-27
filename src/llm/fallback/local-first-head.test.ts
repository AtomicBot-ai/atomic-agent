import { describe, expect, it } from "vitest";

import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { localFirstTurnHead, type LocalFirstInput } from "./local-first-head.js";
import { ProviderFallbackChain, type ProviderSwitchNotice } from "./provider-fallback-chain.js";

function input(overrides: Partial<LocalFirstInput> = {}): LocalFirstInput {
  return {
    localFirst: true,
    effectiveRunMode: "cloud",
    activeProviderId: "openrouter",
    providers: [
      { id: "openrouter" },
      { id: "local-llama", local: true },
    ],
    hasImage: false,
    isRegistered: () => true,
    isUnavailable: () => false,
    ...overrides,
  };
}

describe("localFirstTurnHead (ATO-2208)", () => {
  it("starts a cloud turn on the local provider when localFirst is on", () => {
    expect(localFirstTurnHead(input())).toEqual({ head: "local-llama" });
  });

  it("is off by default and when the flag is false", () => {
    expect(localFirstTurnHead(input({ localFirst: undefined }))).toEqual({
      head: null,
      reason: "off",
    });
    expect(localFirstTurnHead(input({ localFirst: false }))).toEqual({
      head: null,
      reason: "off",
    });
  });

  it("does nothing under Fusion or for a pinned turn", () => {
    expect(localFirstTurnHead(input({ effectiveRunMode: "fusion" }))).toMatchObject({
      head: null,
      reason: "fusion",
    });
    expect(localFirstTurnHead(input({ pinnedProviderId: "openrouter" }))).toMatchObject({
      head: null,
      reason: "pinned",
    });
  });

  it("does nothing when the active provider is already local", () => {
    expect(
      localFirstTurnHead(
        input({ activeProviderId: "local-llama", effectiveRunMode: "local" }),
      ),
    ).toMatchObject({ head: null, reason: "active-local" });
  });

  it("skips a local link that is not built, has no model, or cannot serve the turn", () => {
    expect(localFirstTurnHead(input({ isRegistered: (id) => id !== "local-llama" })))
      .toMatchObject({ head: null, reason: "no-local" });
    expect(localFirstTurnHead(input({ isUnavailable: (id) => id === "local-llama" })))
      .toMatchObject({ head: null, reason: "no-local" });
    expect(
      localFirstTurnHead(
        input({
          providers: [{ id: "openrouter" }, { id: "local-llama", local: true, supportsTools: false }],
        }),
      ),
    ).toMatchObject({ head: null, reason: "no-local" });
    expect(
      localFirstTurnHead(
        input({
          hasImage: true,
          providers: [{ id: "openrouter" }, { id: "local-llama", local: true, supportsVision: false }],
        }),
      ),
    ).toMatchObject({ head: null, reason: "no-local" });
  });

  it("does nothing when no local provider is configured", () => {
    expect(localFirstTurnHead(input({ providers: [{ id: "openrouter" }] }))).toMatchObject({
      head: null,
      reason: "no-local",
    });
  });

  it("picks the first usable local provider in config order", () => {
    expect(
      localFirstTurnHead(
        input({
          providers: [
            { id: "openrouter" },
            { id: "local-a", local: true },
            { id: "local-b", local: true },
          ],
          isUnavailable: (id) => id === "local-a",
        }),
      ),
    ).toEqual({ head: "local-b" });
  });

  it("keeps a session too long for the local window in the cloud (ATO-2537)", () => {
    const window = (id: string) => (id === "local-llama" ? 16_384 : null);
    expect(
      localFirstTurnHead(input({ sessionPromptTokens: 100_000, localContextWindow: window })),
    ).toEqual({ head: null, reason: "too-long" });
    // Past the compaction trigger share of the window, not only past the window.
    expect(
      localFirstTurnHead(input({ sessionPromptTokens: 15_500, localContextWindow: window })),
    ).toEqual({ head: null, reason: "too-long" });
    expect(
      localFirstTurnHead(input({ sessionPromptTokens: 15_500, localContextWindow: window, fitRatio: 0.99 })),
    ).toEqual({ head: "local-llama" });
    expect(
      localFirstTurnHead(input({ sessionPromptTokens: 4_000, localContextWindow: window })),
    ).toEqual({ head: "local-llama" });
  });

  it("an unknown size or window keeps the local head", () => {
    const window = () => 16_384;
    expect(localFirstTurnHead(input({ sessionPromptTokens: null, localContextWindow: window })))
      .toEqual({ head: "local-llama" });
    expect(localFirstTurnHead(input({ sessionPromptTokens: 100_000 })))
      .toEqual({ head: "local-llama" });
    expect(localFirstTurnHead(input({ sessionPromptTokens: 100_000, localContextWindow: () => null })))
      .toEqual({ head: "local-llama" });
  });

  it("takes a later local link whose window fits", () => {
    expect(
      localFirstTurnHead(
        input({
          providers: [
            { id: "openrouter" },
            { id: "local-small", local: true },
            { id: "local-big", local: true },
          ],
          sessionPromptTokens: 60_000,
          localContextWindow: (id) => (id === "local-big" ? 131_072 : 16_384),
        }),
      ),
    ).toEqual({ head: "local-big" });
  });

  it("with the head set on the chain, a failed local turn goes on in the cloud and says so", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: ["openrouter"], timing: DEFAULT_FALLBACK_TIMING }),
      noticeSink: (n) => notices.push(n),
    });
    const decision = localFirstTurnHead(input());
    expect(decision.head).toBe("local-llama");
    chain.setTurnPrimary("s1", decision.head);

    expect(chain.pickProvider("s1")).toEqual({ providerId: "local-llama", isProbe: false });
    const down = new OpenAiHttpError("down", 503, "http://127.0.0.1:8080", false, null, "local-llama");
    expect(chain.advanceFrom("local-llama", down, "s1")).toBe("openrouter");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: "away", from: "local-llama", to: "openrouter" });

    // The turn ends: the configured chain (cloud first) is back.
    chain.setTurnPrimary("s1", null);
    expect(chain.pickProvider("s1")).toEqual({ providerId: "openrouter", isProbe: false });
  });
});
