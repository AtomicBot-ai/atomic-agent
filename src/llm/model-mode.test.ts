import { describe, expect, it } from "vitest";
import { captureModelModePolicy, resolveModelMode } from "./model-mode.js";
import type { ResolvedLlmConfig } from "./provider/registry/provider-types.js";

function config(): ResolvedLlmConfig {
  return {
    activeTextProvider: "remote", activeEmbeddingProvider: "local", toolTransport: "auto",
    providers: [
      { id: "remote", kind: "openrouter", defaultChatModel: "large", modelMode: "cloud", modelModes: { small: "local" }, apiKey: "not-in-snapshot" },
      { id: "local", kind: "llama-server", modelMode: "local" },
      { id: "legacy", kind: "openai-compatible", baseUrl: "https://remote.invalid" },
    ],
  };
}

describe("model mode policy", () => {
  it("resolves a model override, provider default and legacy local independently of routing", () => {
    const policy = captureModelModePolicy(config());
    expect(resolveModelMode(policy)).toEqual({ mode: "cloud", source: "provider", providerId: "remote", modelId: "large" });
    expect(resolveModelMode(policy, "remote", "small")).toMatchObject({ mode: "local", source: "model" });
    expect(resolveModelMode(policy, "legacy")).toMatchObject({ mode: "local", source: "legacy" });
    expect(resolveModelMode(policy, "local")).toMatchObject({ mode: "local", source: "provider" });
    expect(resolveModelMode(policy, "unknown")).toMatchObject({ mode: "local", source: "legacy" });
  });

  it("holds a credential-free snapshot across config edits and resolves worker/fallback entries from it", () => {
    const live = config();
    const policy = captureModelModePolicy(live, id => id === "local" ? "managed-model" : null);
    live.providers[0]!.modelMode = "local";
    live.providers[0]!.modelModes = { small: "cloud" };
    live.activeTextProvider = "local";
    expect(resolveModelMode(policy)).toMatchObject({ mode: "cloud", providerId: "remote" });
    expect(resolveModelMode(policy, "remote", "small").mode).toBe("local");
    expect(resolveModelMode(policy, "local").modelId).toBe("managed-model");
    expect(JSON.stringify(policy)).not.toContain("not-in-snapshot");
    expect(resolveModelMode(captureModelModePolicy(live)).providerId).toBe("local");
  });

  it("does not treat inherited object properties as model overrides", () => {
    const policy = captureModelModePolicy(config());
    expect(resolveModelMode(policy, "remote", "toString").mode).toBe("cloud");
    expect(resolveModelMode(policy, "remote", "__proto__").mode).toBe("cloud");
  });
});
