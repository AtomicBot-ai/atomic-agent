import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import { byteEstimateCounter } from "../llm/token-counter.js";
import { createCompactionTokenCounter } from "./compaction-token-counter.js";

function config(url = "http://127.0.0.1:18080"): AtomicAgentConfig {
  return {
    llm: { activeTextProvider: "box", activeEmbeddingProvider: "box", toolTransport: "auto",
      providers: [{ id: "box", kind: "llama-server", url, apiKey: "entry-key" }, { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1" }] },
    localModels: { url: "http://127.0.0.1:8080", apiKey: null, managed: { modelId: "qwen" } },
    paths: {},
  } as unknown as AtomicAgentConfig;
}

describe("createCompactionTokenCounter (ATO-656)", () => {
  beforeEach(() => { vi.stubEnv("ATOMIC_AGENT_LLAMA_API_KEY", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gives a cloud route the byte estimate and makes no request", async () => {
    const fetch = vi.fn();
    const counterFor = createCompactionTokenCounter({ config: () => config(), route: () => ({ providerId: "cloud", local: false }), fetch });
    const counter = counterFor("s")!;
    expect(counter).toBe(byteEstimateCounter);
    expect(await counter.count("12345678")).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the local route's own server, with its key, and reuses one counter per URL", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }));
    const counterFor = createCompactionTokenCounter({ config: () => config(), route: () => ({ providerId: "box", local: true }), fetch });
    const counter = counterFor("s")!;
    expect(counterFor("other")).toBe(counter);
    expect(await counter.count("a b c")).toBe(3);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18080/tokenize");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer entry-key");
  });
});
