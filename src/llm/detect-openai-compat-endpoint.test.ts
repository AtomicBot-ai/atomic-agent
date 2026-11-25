import { describe, expect, it, vi } from "vitest";

import {
  detectOpenAiCompatEndpoint,
  modelListCandidates,
  probeOpenAiCompatEndpoint,
  providerBaseUrl,
} from "./detect-openai-compat-endpoint.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("modelListCandidates", () => {
  it("asks a base that already ends in /v1 as-is, then the root form", () => {
    expect(modelListCandidates("https://models.example.com/v1")).toEqual([
      "https://models.example.com/v1/models",
    ]);
  });

  it("asks /v1/models first for a bare base", () => {
    expect(modelListCandidates("https://models.example.com")).toEqual([
      "https://models.example.com/v1/models",
      "https://models.example.com/models",
    ]);
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(modelListCandidates("https://box/llm")).toEqual([
      "https://box/llm/v1/models",
      "https://box/llm/models",
    ]);
  });

  it("returns nothing for an unparseable base", () => {
    expect(modelListCandidates("not a url")).toEqual([]);
  });
});

describe("providerBaseUrl", () => {
  it("strips a trailing /v1, because call sites append it themselves", () => {
    expect(providerBaseUrl("https://models.example.com/v1")).toBe(
      "https://models.example.com",
    );
    expect(providerBaseUrl("https://models.example.com/v1/")).toBe(
      "https://models.example.com",
    );
    expect(providerBaseUrl("https://models.example.com")).toBe(
      "https://models.example.com",
    );
  });
});

describe("detectOpenAiCompatEndpoint", () => {
  it("detects an OpenAI-compatible model list and returns its ids", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/v1/models")
        ? jsonResponse({ data: [{ id: "gpt-x" }, { id: "gpt-y" }] })
        : new Response("nope", { status: 404 }),
    );
    const found = await detectOpenAiCompatEndpoint(
      "https://models.example.com/v1",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(found).toEqual({
      baseUrl: "https://models.example.com",
      models: ["gpt-x", "gpt-y"],
    });
  });

  it("falls back to /models when /v1/models is not there", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/models") && !url.endsWith("/v1/models")
        ? jsonResponse({ data: [{ id: "root-model" }] })
        : new Response("nope", { status: 404 }),
    );
    const found = await detectOpenAiCompatEndpoint(
      "https://gateway.example.com",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(found?.models).toEqual(["root-model"]);
  });

  it("returns null for a llama-server (404 on every model list)", async () => {
    const fetchImpl = vi.fn(async () => new Response("404", { status: 404 }));
    expect(
      await detectOpenAiCompatEndpoint("http://127.0.0.1:9931", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns null when the body is not an OpenAI model list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ok" }));
    expect(
      await detectOpenAiCompatEndpoint("http://127.0.0.1:9931", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("sends the bearer key when one is given", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ data: [{ id: "m" }] });
    });
    await detectOpenAiCompatEndpoint("https://models.example.com", {
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[0]?.authorization).toBe("Bearer sk-test");
  });
});

describe("probeOpenAiCompatEndpoint", () => {
  it("reports needs_auth when the model list answers 401", async () => {
    // The reported case: a hosted gateway whose /v1/models answers 401
    // without a key. That is proof of the wire format, not a wrong URL.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "401", message: "Missing or invalid Authorization header" } },
        401,
      ),
    );
    const probe = await probeOpenAiCompatEndpoint(
      "https://models.think.evroc.com/v1",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(probe).toEqual({
      kind: "needs_auth",
      baseUrl: "https://models.think.evroc.com",
    });
  });

  it("reports needs_auth for a 403 too", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const probe = await probeOpenAiCompatEndpoint("https://gw.example.com", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(probe.kind).toBe("needs_auth");
  });

  it("reports ok with the model list when a key is accepted", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "m1" }] }));
    const probe = await probeOpenAiCompatEndpoint("https://gw.example.com", {
      apiKey: "sk-good",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(probe).toEqual({
      kind: "ok",
      detection: { baseUrl: "https://gw.example.com", models: ["m1"] },
    });
  });

  it("reports not_openai_compat for a llama-server", async () => {
    const fetchImpl = vi.fn(async () => new Response("404", { status: 404 }));
    const probe = await probeOpenAiCompatEndpoint("http://127.0.0.1:9931", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(probe.kind).toBe("not_openai_compat");
  });
});
