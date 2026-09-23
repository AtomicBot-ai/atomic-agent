import { describe, it, expect } from "vitest";
import type { ResolvedLlmConfig } from "./registry/provider-types.js";
import { modelWantsStrictTools } from "./model-strict-tools.js";

/**
 * The bootstrap leg: the only path from an operator's
 * `supportsTools: "strict"` to a strict tools payload on the wire.
 * Everything downstream of it is exercised elsewhere; without this,
 * nothing pinned that the config knob reaches the request at all.
 */
function configWith(
  providers: ResolvedLlmConfig["providers"],
): ResolvedLlmConfig {
  return {
    activeTextProvider: providers[0]?.id ?? "p",
    activeEmbeddingProvider: providers[0]?.id ?? "p",
    providers,
    toolTransport: "auto",
  };
}

const strictEntry = {
  id: "gate",
  kind: "openai-compatible",
  baseUrl: "https://gate.example/v1",
  defaultChatModel: "mercury-2.5",
  userModels: [{ id: "mercury-2.5", supportsTools: "strict" as const }],
};

describe("modelWantsStrictTools", () => {
  it("is true only for the model the operator marked strict", () => {
    const resolved = configWith([strictEntry]);
    expect(modelWantsStrictTools(resolved, "gate")).toBe(true);
  });

  it("is false for another model on the same endpoint", () => {
    // The level rides on the model, not the provider. Swapping the
    // served model must drop the strict payload with it.
    const resolved = configWith([
      { ...strictEntry, defaultChatModel: "some-other-model" },
    ]);
    expect(modelWantsStrictTools(resolved, "gate")).toBe(false);
  });

  it("is false for every other declared level", () => {
    for (const level of ["none", "basic", "parallel"] as const) {
      const resolved = configWith([
        {
          ...strictEntry,
          userModels: [{ id: "mercury-2.5", supportsTools: level }],
        },
      ]);
      expect(modelWantsStrictTools(resolved, "gate"), level).toBe(false);
    }
  });

  it("is false with no userModels entry at all — the default config", () => {
    const { userModels: _drop, ...bare } = strictEntry;
    expect(modelWantsStrictTools(configWith([bare]), "gate")).toBe(false);
  });

  it("falls back to `model` when there is no defaultChatModel", () => {
    const { defaultChatModel: _drop, ...byModel } = strictEntry;
    expect(
      modelWantsStrictTools(configWith([{ ...byModel, model: "mercury-2.5" }]), "gate"),
    ).toBe(true);
  });

  it("is false for an unknown provider id or a link with no model", () => {
    const resolved = configWith([strictEntry]);
    expect(modelWantsStrictTools(resolved, "not-configured")).toBe(false);
    const { defaultChatModel: _drop, ...noModel } = strictEntry;
    expect(modelWantsStrictTools(configWith([noModel]), "gate")).toBe(false);
  });
});
