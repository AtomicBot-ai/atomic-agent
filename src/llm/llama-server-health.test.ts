import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import { checkLlamaServer } from "./llama-server-health.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => "<!DOCTYPE html><html><body>KoboldCpp</body></html>",
  };
}

describe("checkLlamaServer", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "llama-health-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("accepts a real llama.cpp /health answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "ok" })));
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
    });
    expect(result.reachable).toBe(true);
    expect(result.kind).toBe("llama-server");
  });

  it("rejects a 200 that is not llama.cpp's health shape (KoboldCpp web UI)", async () => {
    // First call: /health returns HTML. Second call: /v1/models also HTML,
    // so this is not even an OpenAI-compatible endpoint.
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse()));
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:5001",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("unknown");
    expect(result.error).toContain("not with llama.cpp");
  });

  it("identifies an OpenAI-compatible runner via the /v1/models fallback", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/health")) return htmlResponse();
      if (u.endsWith("/v1/models")) {
        return jsonResponse({ data: [{ id: "koboldcpp/model" }] });
      }
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:5001",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("openai-compat");
  });

  it("reports unknown when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:9999",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("unknown");
    expect(result.error).toContain("fetch failed");
  });

  it("returns after the first successful attempt when retrying", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/health")) {
          calls += 1;
          if (calls === 1) throw new Error("cold start");
          return jsonResponse({ status: "ok" });
        }
        throw new Error("unexpected");
      }),
    );
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 2,
      backoffMs: 1,
    });
    expect(result.reachable).toBe(true);
    expect(calls).toBe(2);
  });

  it("recognizes a new-build llama.cpp 503 while the model loads", async () => {
    // Fresh llama.cpp builds answer /health with 503 and an error body
    // (no `status` field) until the model finishes loading.
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: 503, message: "Loading model..." } },
        false,
        503,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("llama-loading");
    expect(result.error).toContain("loading");
    // This IS a llama-server; the OpenAI-compat probe must not run and
    // misidentify it as a different runner.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/v1/models"))).toBe(false);
  });

  it("recognizes an old-build llama.cpp 503 with a status body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "loading model" }, false, 503),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("llama-loading");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/v1/models"))).toBe(false);
  });

  it("does not retry a deterministic 200 with a non-llama body", async () => {
    // KoboldCpp's web UI answers 200 with HTML on every path; the same
    // answer will come back on every retry, so the loop must bail early
    // instead of burning the whole backoff budget.
    let healthCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/health")) {
        healthCalls += 1;
        return htmlResponse();
      }
      return htmlResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:5001",
      retries: 3,
      backoffMs: 1,
    });
    expect(result.kind).toBe("unknown");
    expect(healthCalls).toBe(1);
  });

  it("skips the OpenAI-compat probe when nothing answered at all", async () => {
    // Connection refused / timeout means no server spoke; asking
    // /v1/models afterwards only adds dead seconds.
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:9999",
      retries: 0,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("unknown");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/v1/models"))).toBe(false);
  });

  it("probes /health under a reverse-proxy path prefix", async () => {
    // The exact "works via openai-compatible, dead via external" split:
    // the compat client concatenates and reaches /llama/v1/models, while
    // this probe used to resolve "/health" against the origin and 404.
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "https://box.example/llama",
      retries: 0,
    });
    expect(result.reachable).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://box.example/llama/health",
    );
  });

  it("keeps the prefix on the openai-compat detection probe too", async () => {
    // Behind a prefix, an LM Studio-style box must still be recognized
    // and steered — otherwise the operator just sees "http 404".
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/v1/models")) {
        return jsonResponse({ object: "list", data: [] });
      }
      return jsonResponse({ error: "no health here" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "https://box.example/lmstudio",
      retries: 0,
    });
    expect(result.kind).toBe("openai-compat");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://box.example/lmstudio/v1/models");
  });

  it("verifyAuth reports a --api-key server as llama-auth", async () => {
    // llama.cpp exempts /health from --api-key, so the plain probe
    // passes and the row claims healthy while every completion 401s.
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/health")) return jsonResponse({ status: "ok" });
      return jsonResponse({ error: { code: 401, message: "Invalid API Key" } }, false, 401);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
      verifyAuth: true,
    });
    expect(result.reachable).toBe(false);
    expect(result.kind).toBe("llama-auth");
    expect(result.error).toContain("requires an API key");
  });

  it("verifyAuth stays off by default so the poller costs one request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
    });
    expect(result.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verifyAuth keeps a passing verdict when /props merely errors", async () => {
    // An old build without /props (404) is still a llama-server;
    // only an explicit 401/403 may flip the verdict.
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/health")) return jsonResponse({ status: "ok" });
      return jsonResponse({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
      verifyAuth: true,
    });
    expect(result.reachable).toBe(true);
    expect(result.kind).toBe("llama-server");
  });
});
