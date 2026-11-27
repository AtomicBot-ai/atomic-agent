import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest, LlmProvider, LlmProviderConfigEntry, ResolvedLlmConfig } from "../../llm/provider/index.js";
import { isLocalProviderEntry, localNameModelFor, pickLocalNameEntry } from "./runtime-privacy-names.js";

const LOCAL_URL = "http://127.0.0.1:9931";

function llm(providers: LlmProviderConfigEntry[], active: string): ResolvedLlmConfig {
  return {
    activeTextProvider: active,
    activeEmbeddingProvider: "local-llama-embed",
    providers,
    toolTransport: "auto",
  };
}

describe("isLocalProviderEntry (ATO-2394)", () => {
  it("takes llama-server and servers on this machine or the local network", () => {
    expect(isLocalProviderEntry({ id: "a", kind: "llama-server" }, LOCAL_URL)).toBe(true);
    expect(isLocalProviderEntry({ id: "b", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" }, LOCAL_URL)).toBe(true);
    expect(isLocalProviderEntry({ id: "c", kind: "openai-compatible", baseUrl: "http://192.168.1.20:11434/v1" }, LOCAL_URL)).toBe(true);
  });

  it("refuses every cloud provider, and a llama-server on a public host", () => {
    expect(isLocalProviderEntry({ id: "o", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" }, LOCAL_URL)).toBe(false);
    expect(isLocalProviderEntry({ id: "r", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, LOCAL_URL)).toBe(false);
    expect(isLocalProviderEntry({ id: "s", kind: "subscription-cli" }, LOCAL_URL)).toBe(false);
    expect(isLocalProviderEntry({ id: "l", kind: "llama-server", url: "https://llama.example.com" }, LOCAL_URL)).toBe(false);
    expect(isLocalProviderEntry({ id: "m", kind: "llama-server" }, "https://llama.example.com")).toBe(false);
  });
});

describe("pickLocalNameEntry (ATO-2394)", () => {
  const cloud: LlmProviderConfigEntry = { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" };
  const local: LlmProviderConfigEntry = { id: "local-llama", kind: "llama-server" };
  const studio: LlmProviderConfigEntry = { id: "studio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" };

  it("prefers the active provider when it is local, else the first local one", () => {
    expect(pickLocalNameEntry(llm([cloud, local, studio], "studio"), LOCAL_URL)?.id).toBe("studio");
    expect(pickLocalNameEntry(llm([cloud, local, studio], "cloud"), LOCAL_URL)?.id).toBe("local-llama");
  });

  it("finds nothing when every provider is in the cloud", () => {
    expect(pickLocalNameEntry(llm([cloud], "cloud"), LOCAL_URL)).toBeUndefined();
  });

  it("skips the embedding provider", () => {
    const embed: LlmProviderConfigEntry = { id: "local-llama-embed", kind: "llama-server" };
    expect(pickLocalNameEntry(llm([cloud, embed], "cloud"), LOCAL_URL)).toBeUndefined();
  });
});

describe("localNameModelFor (ATO-2394)", () => {
  it("sends one bounded, constrained request and returns the reply text", async () => {
    const complete = vi.fn(async (_req: CompletionRequest) => ({ content: '{"spans":[]}' }));
    const provider = { id: "local-llama", complete } as unknown as LlmProvider;
    const model = localNameModelFor(provider, { id: "local-llama", kind: "llama-server" }, () => 3);
    const signal = new AbortController().signal;
    const reply = await model.complete({ system: "sys", user: "usr", grammar: "root ::= x", schema: { type: "object" }, signal });
    expect(reply).toBe('{"spans":[]}');
    expect(model.local).toBe(true);
    const req = complete.mock.calls[0]![0];
    expect(req.grammar).toBe("root ::= x");
    expect(req.responseFormat?.schema).toEqual({ type: "object" });
    expect(req.chat).toMatchObject({ system: "sys", user: "usr" });
    expect(req.slotId).toBe(3);
    expect(req.signal).toBe(signal);
    expect(req.maxTokens).toBeGreaterThan(0);
  });
});
