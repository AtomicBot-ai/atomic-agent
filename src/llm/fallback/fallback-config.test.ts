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

  it("orders other cloud providers ahead of the local one for a cloud primary", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud-a",
        providers: [
          P("cloud-a"),
          P("local-llama", "llama-server"),
          P("cloud-b", "openai-compatible"),
          P("cloud-c", "gemini"),
        ],
        // The operator put the local model second; it is still the last
        // resort, because every cloud link is a nearer substitute.
        fallback: {
          chain: ["cloud-a", "local-llama", "cloud-b", "cloud-c"],
          appendLocal: false,
        },
      }),
    );
    expect(resolved.chain).toEqual([
      "cloud-a",
      "cloud-b",
      "cloud-c",
      "local-llama",
    ]);
  });

  it("keeps the operator's within-class order while grouping by class", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud-a",
        providers: [
          P("cloud-a"),
          P("local-llama", "llama-server"),
          // Deliberately configured/listed out of alphabetical order:
          // grouping is a stable partition, not a sort.
          P("cloud-z", "openai-compatible"),
          P("cloud-b", "openai-compatible"),
        ],
        fallback: {
          chain: ["cloud-a", "cloud-z", "local-llama", "cloud-b"],
          appendLocal: false,
        },
      }),
    );
    expect(resolved.chain).toEqual([
      "cloud-a",
      "cloud-z",
      "cloud-b",
      "local-llama",
    ]);
  });

  it("treats subscription-cli as cloud, not local", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud-a",
        providers: [
          P("cloud-a"),
          P("local-llama", "llama-server"),
          P("claude-cli", "subscription-cli"),
        ],
        fallback: {
          chain: ["cloud-a", "local-llama", "claude-cli"],
          appendLocal: false,
        },
      }),
    );
    expect(resolved.chain).toEqual(["cloud-a", "claude-cli", "local-llama"]);
  });

  it("orders other local providers ahead of cloud ones for a local primary", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "local-a",
        providers: [
          P("local-a", "llama-server"),
          P("cloud", "openai-compatible"),
          P("local-b", "llama-server"),
        ],
        fallback: {
          chain: ["local-a", "cloud", "local-b"],
          appendLocal: false,
        },
      }),
    );
    expect(resolved.chain).toEqual(["local-a", "local-b", "cloud"]);
  });

  it("leaves a local primary with a single cloud fallback alone", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "local-llama",
        providers: [P("local-llama", "llama-server"), P("cloud")],
        fallback: { chain: ["local-llama", "cloud"], appendLocal: true },
      }),
    );
    expect(resolved.chain).toEqual(["local-llama", "cloud"]);
  });

  it("sorts an auto-appended local provider behind the configured cloud ones", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud-a",
        providers: [
          P("cloud-a"),
          P("cloud-b", "openai-compatible"),
          P("local-llama", "llama-server"),
        ],
        fallback: { chain: ["cloud-a", "cloud-b"], appendLocal: true },
      }),
    );
    expect(resolved.chain).toEqual(["cloud-a", "cloud-b", "local-llama"]);
  });

  it("keeps every fallback cloud when appendLocal is false", () => {
    const resolved = resolveFallbackChain(
      cfg({
        activeTextProvider: "cloud-a",
        providers: [
          P("cloud-a"),
          P("cloud-b", "openai-compatible"),
          P("local-llama", "llama-server"),
        ],
        fallback: { chain: ["cloud-a", "cloud-b"], appendLocal: false },
      }),
    );
    expect(resolved.chain).toEqual(["cloud-a", "cloud-b"]);
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
