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

  it("still accepts 'loading model' as a llama-server answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "loading model" })),
    );
    const result = await checkLlamaServer({
      url: "http://127.0.0.1:8080",
      retries: 0,
    });
    expect(result.kind).toBe("llama-server");
  });
});
