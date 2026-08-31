import { describe, expect, it } from "vitest";
import {
  describeLlamaHealthFailure,
  looksLikeOllamaUrl,
} from "./describe-llama-health-failure.js";
import type { HealthResult } from "./llama-server-health.js";

function result(partial: Partial<HealthResult>): HealthResult {
  return {
    reachable: false,
    status: null,
    kind: "unknown",
    error: null,
    latencyMs: 0,
    ...partial,
  };
}

describe("describeLlamaHealthFailure", () => {
  it("steers an openai-compatible server to the cloud provider flow", () => {
    const line = describeLlamaHealthFailure(
      result({ kind: "openai-compat", status: 404, error: "http 404" }),
      "http://127.0.0.1:1234",
    );
    expect(line).toContain("OpenAI-compatible");
    expect(line).toContain("openai-compatible, base URL http://127.0.0.1:1234");
  });

  it("names Ollama outright when the openai-compat server sits on :11434", () => {
    // The most common shape of this verdict by far: the External URL
    // pointed at `ollama serve`. "openai-compatible" alone did not tell
    // an Ollama user the message was about them.
    const line = describeLlamaHealthFailure(
      result({ kind: "openai-compat", status: 404, error: "http 404" }),
      "http://127.0.0.1:11434",
    );
    expect(line).toContain("Ollama");
    expect(line).toContain("base URL http://127.0.0.1:11434");
  });

  it("says wait, not reconfigure, while the model is loading", () => {
    const line = describeLlamaHealthFailure(
      result({ kind: "llama-loading", status: 503 }),
      "http://127.0.0.1:8080",
    );
    expect(line).toContain("still loading");
  });

  it("names the key env var for a --api-key server", () => {
    const line = describeLlamaHealthFailure(
      result({
        kind: "llama-auth",
        status: 401,
        error: "http 401 — the server requires an API key (--api-key)",
      }),
      "http://127.0.0.1:8080",
    );
    expect(line).toContain("ATOMIC_AGENT_LLAMA_API_KEY");
    expect(line).toContain("http 401");
  });

  it("falls back to the raw error with the probed URL", () => {
    const line = describeLlamaHealthFailure(
      result({ kind: "unknown", error: "fetch failed" }),
      "http://10.0.0.7:8080",
    );
    expect(line).toBe("local-llm /health failed at http://10.0.0.7:8080: fetch failed");
  });
});

describe("looksLikeOllamaUrl", () => {
  it("recognizes Ollama's default port on any host", () => {
    expect(looksLikeOllamaUrl("http://127.0.0.1:11434")).toBe(true);
    expect(looksLikeOllamaUrl("http://192.168.1.50:11434")).toBe(true);
  });

  it("rejects other ports and unparseable URLs", () => {
    expect(looksLikeOllamaUrl("http://127.0.0.1:1234")).toBe(false);
    expect(looksLikeOllamaUrl("http://127.0.0.1:8080")).toBe(false);
    expect(looksLikeOllamaUrl("not a url")).toBe(false);
  });
});
