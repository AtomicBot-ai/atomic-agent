import { describe, expect, it, vi } from "vitest";

import { ImportFactsConsentError } from "../../memory/import-facts/index.js";
import { bindImportFactsModel, ImportFactsModelError, type ImportFactsProviderEntry } from "./import-facts-model.js";

const PROVIDERS: ImportFactsProviderEntry[] = [
  { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "local-llama", kind: "llama-server" },
  { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" },
];

function links(content = "SET job=designer\n") {
  const complete = vi.fn(async () => ({ content, toolCalls: [] }) as never);
  return { complete, getProvider: vi.fn(() => ({ complete })) };
}

describe("bindImportFactsModel (ATO-1617)", () => {
  it("local: uses the active provider when it is local, under the grammar", async () => {
    const l = links();
    const bound = bindImportFactsModel({ engine: { kind: "local" }, providers: PROVIDERS, activeTextProvider: "local-llama", getProvider: l.getProvider });
    expect(bound).toMatchObject({ providerId: "local-llama", local: true });
    const out = await bound.complete("p", { grammar: "G", signal: new AbortController().signal });
    expect(out).toBe("SET job=designer\n");
    expect(l.complete.mock.calls[0]![0]).toMatchObject({ prompt: "p", grammar: "G", slotId: -1 });
  });

  it("local: never picks the active cloud provider; falls back to the first local entry", () => {
    const l = links();
    const bound = bindImportFactsModel({ engine: { kind: "local" }, providers: PROVIDERS, activeTextProvider: "openrouter", getProvider: l.getProvider });
    expect(bound.providerId).toBe("local-llama");
  });

  it("local: a local OpenAI-compatible server counts as local and is asked through the emit tool", async () => {
    const complete = vi.fn(async () => ({ content: "", toolCalls: [{ function: { arguments: JSON.stringify({ lines: "SET city=Berlin" }) } }] }) as never);
    const bound = bindImportFactsModel({
      engine: { kind: "local" },
      providers: [PROVIDERS[0]!, PROVIDERS[2]!],
      activeTextProvider: "lmstudio",
      getProvider: () => ({ complete }),
    });
    expect(bound).toMatchObject({ providerId: "lmstudio", local: true });
    expect(await bound.complete("p", { grammar: "G", signal: new AbortController().signal })).toBe("SET city=Berlin");
    expect((complete.mock.calls[0] as unknown[])[0]).toHaveProperty("tools");
  });

  it("local with no local entry is refused before anything is sent", () => {
    const l = links();
    expect(() =>
      bindImportFactsModel({ engine: { kind: "local" }, providers: [PROVIDERS[0]!], activeTextProvider: "openrouter", getProvider: l.getProvider }),
    ).toThrow(ImportFactsModelError);
    expect(l.complete).not.toHaveBeenCalled();
  });

  it("cloud without this run's consent is refused", () => {
    const l = links();
    expect(() =>
      bindImportFactsModel({ engine: { kind: "cloud", provider: "openrouter", cloudConsent: false }, providers: PROVIDERS, activeTextProvider: "openrouter", getProvider: l.getProvider }),
    ).toThrow(ImportFactsConsentError);
  });

  it("cloud with consent uses exactly the picked provider; a local id is refused as not_cloud", () => {
    const l = links();
    const bound = bindImportFactsModel({ engine: { kind: "cloud", provider: "openrouter", cloudConsent: true }, providers: PROVIDERS, activeTextProvider: "local-llama", getProvider: l.getProvider });
    expect(bound).toMatchObject({ providerId: "openrouter", local: false });
    try {
      bindImportFactsModel({ engine: { kind: "cloud", provider: "local-llama", cloudConsent: true }, providers: PROVIDERS, activeTextProvider: "local-llama", getProvider: l.getProvider });
      expect.unreachable();
    } catch (err) {
      expect((err as ImportFactsModelError).code).toBe("not_cloud");
    }
  });

  it("local means this computer only: LAN, .internal and remote llama.cpp need the cloud consent", () => {
    const l = links();
    const away: ImportFactsProviderEntry[] = [
      { id: "lan-llama", kind: "llama-server", url: "https://llm.example.com" },
      { id: "lan-box", kind: "openai-compatible", baseUrl: "http://192.168.1.20:8080/v1" },
      { id: "gateway", kind: "openai-compatible", baseUrl: "http://gpu.internal/v1" },
    ];
    for (const entry of away) {
      try {
        bindImportFactsModel({ engine: { kind: "local" }, providers: [entry], activeTextProvider: entry.id, getProvider: l.getProvider });
        expect.unreachable();
      } catch (err) {
        expect((err as ImportFactsModelError).code).toBe("no_local_model");
      }
      const bound = bindImportFactsModel({
        engine: { kind: "cloud", provider: entry.id, cloudConsent: true },
        providers: [entry],
        activeTextProvider: entry.id,
        getProvider: l.getProvider,
      });
      expect(bound.local).toBe(false);
    }
    expect(l.complete).not.toHaveBeenCalled();
  });

  it("a llama-server on 127.0.0.1 is local even when its embeddings daemon url is elsewhere", () => {
    const l = links();
    const bound = bindImportFactsModel({
      engine: { kind: "local" },
      providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080", baseUrl: "http://192.168.1.5:8081" }],
      activeTextProvider: "local-llama",
      getProvider: l.getProvider,
    });
    expect(bound.local).toBe(true);
  });
});
