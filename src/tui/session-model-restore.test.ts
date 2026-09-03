import { describe, expect, it } from "vitest";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";
import {
  describeModelRestore,
  planModelRestore,
} from "./session-model-restore.js";

function resolved(overrides: Partial<ResolvedLlmConfig> = {}): ResolvedLlmConfig {
  return {
    activeTextProvider: "openrouter",
    activeEmbeddingProvider: "local-llama-embed",
    toolTransport: "auto",
    providers: [
      {
        id: "openrouter",
        kind: "openrouter",
        defaultChatModel: "z-ai/glm-5.2",
      },
      { id: "local-llama", kind: "llama-server" },
      { id: "aimlapi", kind: "aimlapi", model: "legacy-model" },
    ],
    ...overrides,
  };
}

describe("planModelRestore", () => {
  it("does nothing without a stamp", () => {
    expect(planModelRestore(null, resolved())).toEqual({ kind: "none" });
  });

  it("does nothing when the stamp is already the active provider/model", () => {
    expect(
      planModelRestore(
        { providerId: "openrouter", chatModel: "z-ai/glm-5.2" },
        resolved(),
      ),
    ).toEqual({ kind: "none" });
  });

  it("selects the stamped model when the session ran on a different one", () => {
    expect(
      planModelRestore(
        { providerId: "openrouter", chatModel: "another/model" },
        resolved(),
      ),
    ).toEqual({
      kind: "select",
      providerId: "openrouter",
      modelId: "another/model",
    });
  });

  it("selects across providers, falling back to the legacy `model` field", () => {
    expect(
      planModelRestore(
        { providerId: "aimlapi", chatModel: "legacy-model" },
        resolved(),
      ),
    ).toEqual({
      kind: "select",
      providerId: "aimlapi",
      modelId: "legacy-model",
    });
  });

  it("activates a model-less provider instead of selecting", () => {
    expect(
      planModelRestore({ providerId: "local-llama", chatModel: null }, resolved()),
    ).toEqual({ kind: "activate", providerId: "local-llama" });
    // …and stays put when that provider is already active.
    expect(
      planModelRestore(
        { providerId: "local-llama", chatModel: null },
        resolved({ activeTextProvider: "local-llama" }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("reports a provider deleted since the session ran, changing nothing", () => {
    const plan = planModelRestore(
      { providerId: "gone", chatModel: "x/y" },
      resolved(),
    );
    expect(plan).toEqual({ kind: "missing", providerId: "gone", chatModel: "x/y" });
    expect(describeModelRestore(plan)).toContain("no longer configured");
  });

  it("describes only plans that act or warn", () => {
    expect(describeModelRestore({ kind: "none" })).toBeNull();
    expect(
      describeModelRestore({
        kind: "select",
        providerId: "openrouter",
        modelId: "another/model",
      }),
    ).toContain("openrouter/another/model");
    expect(
      describeModelRestore({ kind: "activate", providerId: "local-llama" }),
    ).toContain("local-llama");
  });
});
