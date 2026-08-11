import { describe, expect, it } from "vitest";

import type { ResolvedLlmConfig } from "../../../llm/provider/registry/provider-types.js";
import { buildFallbackChainView } from "./fallback-panel-selectors.js";

function resolved(over: Partial<ResolvedLlmConfig> = {}): ResolvedLlmConfig {
  return {
    activeTextProvider: "cloud-a",
    activeEmbeddingProvider: "cloud-a",
    toolTransport: "auto",
    providers: [
      { id: "cloud-a", kind: "openrouter", defaultChatModel: "vendor/a" },
      { id: "cloud-b", kind: "aimlapi", defaultChatModel: "vendor/b" },
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
    ],
    ...over,
  };
}

describe("buildFallbackChainView", () => {
  it("lists the effective chain in order with the active provider as the head", () => {
    const view = buildFallbackChainView(
      resolved({ fallback: { chain: ["cloud-a", "cloud-b"], appendLocal: false } }),
    );
    expect(view.links.map((l) => l.providerId)).toEqual(["cloud-a", "cloud-b"]);
    expect(view.links[0]).toMatchObject({
      providerId: "cloud-a",
      isActive: true,
      modelLabel: "vendor/a",
      kind: "openrouter",
    });
    expect(view.links[1]).toMatchObject({ providerId: "cloud-b", isActive: false });
  });

  it("hoists the active text provider to the head even when listed later", () => {
    const view = buildFallbackChainView(
      resolved({
        activeTextProvider: "cloud-b",
        fallback: { chain: ["cloud-a", "cloud-b"], appendLocal: false },
      }),
    );
    expect(view.links.map((l) => l.providerId)).toEqual(["cloud-b", "cloud-a"]);
    expect(view.links[0]!.isActive).toBe(true);
  });

  it("marks the auto-appended local last resort", () => {
    const view = buildFallbackChainView(
      resolved({ fallback: { chain: ["cloud-a"], appendLocal: true } }),
    );
    expect(view.links.map((l) => l.providerId)).toEqual(["cloud-a", "local-llama"]);
    const local = view.links.find((l) => l.providerId === "local-llama")!;
    expect(local.isAppendedLocal).toBe(true);
    expect(view.appendLocal).toBe(true);
  });

  it("does not mark local as appended when the operator lists it explicitly", () => {
    const view = buildFallbackChainView(
      resolved({
        fallback: { chain: ["cloud-a", "local-llama"], appendLocal: true },
      }),
    );
    const local = view.links.find((l) => l.providerId === "local-llama")!;
    expect(local.isAppendedLocal).toBe(false);
  });

  it("defaults the chain to the active provider only when no fallback block is set", () => {
    const view = buildFallbackChainView(
      resolved({
        providers: [{ id: "cloud-a", kind: "openrouter", defaultChatModel: "vendor/a" }],
      }),
    );
    expect(view.links.map((l) => l.providerId)).toEqual(["cloud-a"]);
    expect(view.appendLocal).toBe(true);
  });

  it("computes addable providers as those not in the chain", () => {
    const view = buildFallbackChainView(
      resolved({ fallback: { chain: ["cloud-a"], appendLocal: false } }),
    );
    expect(view.addableProviderIds).toEqual(["cloud-b", "local-llama"]);
  });
});
