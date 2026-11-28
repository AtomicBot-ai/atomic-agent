import { describe, expect, it } from "vitest";

import type { LlmProvider } from "../../llm/index.js";
import type { LlmProviderConfigEntry, ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import { createLocalVisionSlot, pickLocalVisionModel, providerIsLocal, type LocalVisionDeps } from "./file-index-vision.js";

// ATO-2501: My files reads scans and photos only with a model on this machine.
function provider(id: string, vision: boolean): LlmProvider {
  return { id, name: id, capabilities: { vision } } as unknown as LlmProvider;
}

function deps(
  entries: Array<Partial<LlmProviderConfigEntry> & { id: string; kind: string }>,
  providers: LlmProvider[],
  active: string,
  localModelsUrl = "http://127.0.0.1:19091",
): LocalVisionDeps {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const llm = { activeTextProvider: active, activeEmbeddingProvider: active, providers: entries, toolTransport: "auto" } as unknown as ResolvedLlmConfig;
  return {
    registry: { activeTextProviderId: active, getProvider: (id) => byId.get(id), listIds: () => [...byId.keys()] },
    readLlm: () => llm,
    localModelsUrl: () => localModelsUrl,
  };
}

describe("pickLocalVisionModel", () => {
  it("uses the active provider when it is local and reads images", () => {
    const local = provider("local", true);
    const picked = pickLocalVisionModel(deps([{ id: "local", kind: "llama-server" }], [local], "local"));
    expect(picked).toBe(local);
  });

  it("never picks a cloud provider, even the active one that reads images", () => {
    const cloud = provider("cloud", true);
    const local = provider("lmstudio", true);
    const d = deps(
      [
        { id: "cloud", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
        { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
      ],
      [cloud, local],
      "cloud",
    );
    expect(pickLocalVisionModel(d)).toBe(local);
    const cloudOnly = deps([{ id: "cloud", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }], [cloud], "cloud");
    expect(pickLocalVisionModel(cloudOnly)).toBeUndefined();
  });

  it("passes over a local model without a projector", () => {
    const blind = provider("local", false);
    expect(pickLocalVisionModel(deps([{ id: "local", kind: "llama-server" }], [blind], "local"))).toBeUndefined();
  });

  it("answers nothing when the config cannot be read", () => {
    const d = deps([{ id: "local", kind: "llama-server" }], [provider("local", true)], "local");
    expect(pickLocalVisionModel({ ...d, readLlm: () => { throw new Error("bad config"); } })).toBeUndefined();
  });
});

describe("providerIsLocal", () => {
  const llm = (entries: Array<Partial<LlmProviderConfigEntry> & { id: string; kind: string }>) =>
    ({ providers: entries }) as unknown as ResolvedLlmConfig;

  it("reads a llama-server entry's own URL, else localModels.url", () => {
    expect(providerIsLocal(llm([{ id: "a", kind: "llama-server" }]), "a", "http://127.0.0.1:9931")).toBe(true);
    expect(providerIsLocal(llm([{ id: "a", kind: "llama-server" }]), "a", "https://gpu.example.com")).toBe(false);
    expect(providerIsLocal(llm([{ id: "a", kind: "llama-server", url: "http://192.168.1.20:8080" }]), "a", "https://gpu.example.com")).toBe(true);
  });

  it("treats an id config does not list as not local", () => {
    expect(providerIsLocal(llm([]), "ghost", "http://127.0.0.1:9931")).toBe(false);
  });
});

describe("createLocalVisionSlot", () => {
  it("answers nothing until the registry is attached", () => {
    const slot = createLocalVisionSlot();
    expect(slot.read()).toBeUndefined();
    const local = provider("local", true);
    slot.attach(deps([{ id: "local", kind: "llama-server" }], [local], "local"));
    expect(slot.read()).toBe(local);
  });
});
