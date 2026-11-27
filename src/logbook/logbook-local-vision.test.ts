import { describe, expect, it } from "vitest";

import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import {
  entryRunsOnThisMachine,
  logbookNotesStayLocal,
  NO_LOCAL_VISION_REASON,
  pickLocalVisionProvider,
  type LogbookVisionProvider,
} from "./logbook-local-vision.js";

function provider(id: string, vision: boolean): LogbookVisionProvider {
  return {
    id,
    name: id,
    capabilities: { vision, visionSource: vision ? "mmproj" : "absent" },
    describeImage: async () => ({ text: "x", durationMs: 1 }),
  };
}

const LOCAL_URL = "http://127.0.0.1:8080";

describe("entryRunsOnThisMachine", () => {
  it("counts the built-in engine and loopback servers as local", () => {
    expect(entryRunsOnThisMachine({ id: "local-llama", kind: "llama-server" }, LOCAL_URL)).toBe(true);
    expect(entryRunsOnThisMachine({ id: "l", kind: "llama-server", url: "http://localhost:9000" }, LOCAL_URL)).toBe(true);
    expect(entryRunsOnThisMachine({ id: "ollama", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" }, LOCAL_URL)).toBe(true);
  });

  it("never counts a cloud API, a LAN server or a remote engine as local", () => {
    expect(entryRunsOnThisMachine({ id: "or", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, LOCAL_URL)).toBe(false);
    expect(entryRunsOnThisMachine({ id: "lan", kind: "openai-compatible", baseUrl: "http://192.168.1.20:1234/v1" }, LOCAL_URL)).toBe(false);
    expect(entryRunsOnThisMachine({ id: "remote", kind: "llama-server", url: "http://gpu-box.example.com:8080" }, LOCAL_URL)).toBe(false);
    expect(entryRunsOnThisMachine({ id: "local-llama", kind: "llama-server" }, "http://gpu-box.example.com:8080")).toBe(false);
    expect(entryRunsOnThisMachine({ id: "gemini", kind: "gemini" }, LOCAL_URL)).toBe(false);
  });
});

describe("pickLocalVisionProvider", () => {
  const entries: LlmProviderConfigEntry[] = [
    { id: "cloud", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    { id: "local-llama", kind: "llama-server" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
  ];

  it("never picks a cloud provider, even an active one that can see", () => {
    const providers: Record<string, LogbookVisionProvider> = { cloud: provider("cloud", true), "local-llama": provider("local-llama", false) };
    const pick = pickLocalVisionProvider({ entries, activeId: "cloud", getProvider: (id) => providers[id], localModelsUrl: LOCAL_URL });
    expect(pick).toEqual({ ok: false, reason: NO_LOCAL_VISION_REASON });
  });

  it("prefers the active local provider, else the first local one that can see", () => {
    const providers: Record<string, LogbookVisionProvider> = {
      cloud: provider("cloud", true),
      "local-llama": provider("local-llama", true),
      lmstudio: provider("lmstudio", true),
    };
    const active = pickLocalVisionProvider({ entries, activeId: "lmstudio", getProvider: (id) => providers[id], localModelsUrl: LOCAL_URL });
    expect(active.ok && active.provider.id).toBe("lmstudio");
    const other = pickLocalVisionProvider({ entries, activeId: "cloud", getProvider: (id) => providers[id], localModelsUrl: LOCAL_URL });
    expect(other.ok && other.provider.id).toBe("local-llama");
  });

  it("skips a local provider whose model cannot see", () => {
    const providers: Record<string, LogbookVisionProvider> = { "local-llama": provider("local-llama", false), lmstudio: provider("lmstudio", true) };
    const pick = pickLocalVisionProvider({ entries, activeId: "local-llama", getProvider: (id) => providers[id], localModelsUrl: LOCAL_URL });
    expect(pick.ok && pick.provider.id).toBe("lmstudio");
  });
});

describe("logbookNotesStayLocal", () => {
  const entries: LlmProviderConfigEntry[] = [
    { id: "local-llama", kind: "llama-server" },
    { id: "ollama", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
    { id: "cloud", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ];

  it("is true when the serving model and every fallback are on this computer", () => {
    expect(logbookNotesStayLocal({ entries, providerId: "local-llama", localModelsUrl: LOCAL_URL })).toBe(true);
    expect(
      logbookNotesStayLocal({ entries, providerId: "local-llama", fallbackChain: ["local-llama", "ollama"], localModelsUrl: LOCAL_URL }),
    ).toBe(true);
  });

  it("is false for a cloud model, a cloud fallback or an unknown id", () => {
    expect(logbookNotesStayLocal({ entries, providerId: "cloud", localModelsUrl: LOCAL_URL })).toBe(false);
    expect(
      logbookNotesStayLocal({ entries, providerId: "local-llama", fallbackChain: ["local-llama", "cloud"], localModelsUrl: LOCAL_URL }),
    ).toBe(false);
    expect(logbookNotesStayLocal({ entries, providerId: "gone", localModelsUrl: LOCAL_URL })).toBe(false);
  });
});
