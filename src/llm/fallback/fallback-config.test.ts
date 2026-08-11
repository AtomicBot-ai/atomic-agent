import { describe, it, expect } from "vitest";
import {
  resolveFallbackChain,
  DEFAULT_FALLBACK_TIMING,
} from "./fallback-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";

function cfg(
  partial: Partial<ResolvedLlmConfig> & {
    activeTextProvider: string;
    providers: ResolvedLlmConfig["providers"];
  },
): ResolvedLlmConfig {
  return {
    activeEmbeddingProvider: partial.activeTextProvider,
    toolTransport: "auto",
    ...partial,
  };
}

const P = (id: string, kind = "openrouter") => ({ id, kind });

describe("resolveFallbackChain", () => {
  it("defaults to just the active provider when no fallback config is present", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "primary",
        providers: [P("primary")],
      }),
    );
    expect(resolved.chain).toEqual(["primary"]);
    expect(resolved.timing).toEqual(DEFAULT_FALLBACK_TIMING);
  });

  it("auto-appends the local llama-server provider to the tail by default", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud"), P("local-llama", "llama-server")],
        fallback: { chain: ["cloud"] },
      }),
    );
    expect(resolved.chain).toEqual(["cloud", "local-llama"]);
  });

  it("does not append local when appendLocal is false", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud"), P("local-llama", "llama-server")],
        fallback: { chain: ["cloud"], appendLocal: false },
      }),
    );
    expect(resolved.chain).toEqual(["cloud"]);
  });

  it("appends nothing when no local provider is configured", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud"), P("groq", "openai-compatible")],
        fallback: { chain: ["cloud", "groq"], appendLocal: true },
      }),
    );
    expect(resolved.chain).toEqual(["cloud", "groq"]);
  });

  it("does not duplicate local when it is already in the chain", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud"), P("local-llama", "llama-server")],
        fallback: { chain: ["cloud", "local-llama"], appendLocal: true },
      }),
    );
    expect(resolved.chain).toEqual(["cloud", "local-llama"]);
  });

  it("hoists the active provider to the head of the chain", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "groq",
        providers: [
          P("cloud"),
          P("groq", "openai-compatible"),
          P("local-llama", "llama-server"),
        ],
        // chain lists cloud first, but the active provider is groq.
        fallback: { chain: ["cloud", "groq"], appendLocal: false },
      }),
    );
    expect(resolved.chain[0]).toBe("groq");
    expect(resolved.chain).toEqual(["groq", "cloud"]);
  });

  it("drops chain ids that are not configured providers", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud"), P("groq", "openai-compatible")],
        fallback: { chain: ["cloud", "ghost", "groq"], appendLocal: false },
      }),
    );
    expect(resolved.chain).toEqual(["cloud", "groq"]);
  });

  it("carries timing overrides and falls back to defaults per-field", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud",
        providers: [P("cloud")],
        fallback: {
          chain: ["cloud"],
          appendLocal: false,
          failureThreshold: 5,
          cooldownMs: [1000, 2000],
        },
      }),
    );
    expect(resolved.timing.failureThreshold).toBe(5);
    expect(resolved.timing.cooldownMs).toEqual([1000, 2000]);
    // Unset fields keep the defaults.
    expect(resolved.timing.probeThrottleMs).toBe(
      DEFAULT_FALLBACK_TIMING.probeThrottleMs,
    );
    expect(resolved.timing.failureWindowMs).toBe(
      DEFAULT_FALLBACK_TIMING.failureWindowMs,
    );
  });
});
