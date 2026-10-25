import { describe, expect, it, vi } from "vitest";

import type { HealthCheckOptions, HealthResult } from "./llama-server-health.js";
import { recheckLocalConnection } from "./recheck-local-connection.js";

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

function answering(health: HealthResult) {
  return vi.fn(async (_options: HealthCheckOptions) => health);
}

describe("recheckLocalConnection (ATO-873)", () => {
  it("probes the address once, the way saving it does", async () => {
    const check = answering(result({ reachable: true, status: 200, kind: "llama-server" }));
    await recheckLocalConnection({ url: "http://127.0.0.1:9931", check });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:9931", retries: 0, verifyAuth: true }),
    );
  });

  it("says ready for a llama.cpp server that answers", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:9931",
      check: answering(result({ reachable: true, status: 200, kind: "llama-server" })),
    });
    expect(out).toMatchObject({ verdict: "ok", ok: true, portHint: null });
    expect(out.message).toContain("ready");
  });

  it("names Ollama and steers it to the providers", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:11434",
      check: answering(result({ status: 404, kind: "openai-compat", error: "http 404" })),
    });
    expect(out.verdict).toBe("ollama");
    expect(out.ok).toBe(false);
    expect(out.message).toContain("answers like Ollama");
    expect(out.portHint).toBeNull();
  });

  it("names Atomic Chat on 1337 and any other OpenAI-compatible server", async () => {
    const chat = await recheckLocalConnection({
      url: "http://127.0.0.1:1337",
      check: answering(result({ status: 404, kind: "openai-compat" })),
    });
    expect(chat.verdict).toBe("atomic_chat");
    const other = await recheckLocalConnection({
      url: "http://127.0.0.1:1234",
      check: answering(result({ status: 404, kind: "openai-compat" })),
    });
    expect(other.verdict).toBe("openai_compat");
    expect(other.message).toContain("OpenAI-compatible");
  });

  it("says wait while the model loads", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:9931",
      check: answering(result({ status: 503, kind: "llama-loading" })),
    });
    expect(out.verdict).toBe("loading");
    expect(out.message).toContain("still loading");
  });

  it("names a refused key", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:9931",
      check: answering(result({ status: 401, kind: "llama-auth", error: "http 401" })),
    });
    expect(out.verdict).toBe("key_rejected");
  });

  it("says not a model server, and points the old 8080 default at 9931", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:8080",
      check: answering(result({ status: 404, kind: "unknown", error: "http 404" })),
    });
    expect(out.verdict).toBe("not_model_server");
    expect(out.message).toBe("http://127.0.0.1:8080 answers (http 404), but it isn't a model server.");
    expect(out.portHint).toContain("9931");
  });

  it("gives no port hint for a server the operator put on another port", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:8090",
      check: answering(result({ status: 404, kind: "unknown" })),
    });
    expect(out.verdict).toBe("not_model_server");
    expect(out.portHint).toBeNull();
  });

  it("says nothing answers when the port is closed", async () => {
    const out = await recheckLocalConnection({
      url: "http://127.0.0.1:8080",
      check: answering(result({ status: null, kind: "unknown", error: "fetch failed" })),
    });
    expect(out.verdict).toBe("unreachable");
    expect(out.message).toBe("Nothing answers at http://127.0.0.1:8080. Start the model server, or check the address.");
    expect(out.portHint).toContain("9931");
  });
});
