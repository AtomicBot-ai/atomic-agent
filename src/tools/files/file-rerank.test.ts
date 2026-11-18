import { describe, expect, it } from "vitest";

import {
  applyRerank,
  createHttpReranker,
  parseRerankResponse,
  RERANK_DOCUMENT_CHARS,
  rerankEndpoint,
  rerankerFromEnv,
  type Reranker,
} from "./file-rerank.js";

function fakeFetch(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return answer(body);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("rerankEndpoint", () => {
  it("adds /v1/rerank to a base URL and keeps a full one", () => {
    expect(rerankEndpoint("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081/v1/rerank");
    expect(rerankEndpoint("http://127.0.0.1:8081/")).toBe("http://127.0.0.1:8081/v1/rerank");
    expect(rerankEndpoint("http://127.0.0.1:8081/v1")).toBe("http://127.0.0.1:8081/v1/rerank");
    expect(rerankEndpoint("http://127.0.0.1:8081/rerank")).toBe("http://127.0.0.1:8081/rerank");
  });
});

describe("createHttpReranker", () => {
  it("posts query, documents and top_n, and answers scores best first", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }),
    );
    const reranker = createHttpReranker({ url: "http://127.0.0.1:8081", fetch: impl });
    const long = "x".repeat(RERANK_DOCUMENT_CHARS + 50);
    expect(await reranker.rerank("lease", ["a", long])).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8081/v1/rerank");
    expect(calls[0]!.body).toMatchObject({ query: "lease", top_n: 2 });
    expect((calls[0]!.body.documents as string[])[1]).toHaveLength(RERANK_DOCUMENT_CHARS);
  });

  it("answers null on an HTTP error, a thrown fetch or a body it cannot read", async () => {
    for (const answer of [
      () => json({ error: "no model" }, 500),
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => new Response("not json", { status: 200 }),
      () => json({ results: "nope" }),
    ]) {
      const reranker = createHttpReranker({ url: "http://127.0.0.1:8081", fetch: fakeFetch(answer).impl });
      expect(await reranker.rerank("q", ["a", "b"])).toBeNull();
    }
  });
});

describe("parseRerankResponse", () => {
  it("drops out-of-range, repeated and non-numeric entries", () => {
    expect(
      parseRerankResponse(
        { results: [{ index: 5, relevance_score: 1 }, { index: 0, relevance_score: 0.2 }, { index: 0, relevance_score: 0.9 }, { index: 1, score: "x" }] },
        2,
      ),
    ).toEqual([{ index: 0, score: 0.2 }]);
    expect(parseRerankResponse({ results: [] }, 2)).toBeNull();
    expect(parseRerankResponse(null, 2)).toBeNull();
  });
});

describe("rerankerFromEnv", () => {
  it("is off when unset or blank", () => {
    expect(rerankerFromEnv({})).toBeNull();
    expect(rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: "  " })).toBeNull();
  });

  it("refuses a remote URL with a warning, so file text stays local", () => {
    const warnings: string[] = [];
    expect(rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: "https://api.example.com" }, (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("builds one for a local server", () => {
    expect(rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: "http://127.0.0.1:8081" })).not.toBeNull();
  });
});

describe("applyRerank", () => {
  const fixed = (scores: { index: number; score: number }[] | null): Reranker => ({ rerank: async () => scores });

  it("puts scored items first by score and keeps the rest in order after them", async () => {
    const out = await applyRerank(fixed([{ index: 2, score: 0.8 }, { index: 0, score: 0.5 }]), "q", ["a", "b", "c", "d"], ["", "", "", ""]);
    expect(out.map((o) => o.item)).toEqual(["c", "a", "b", "d"]);
    expect(out.map((o) => o.score)).toEqual([0.8, 0.5, null, null]);
  });

  it("keeps the original order when the reranker gives up", async () => {
    const out = await applyRerank(fixed(null), "q", ["a", "b"], ["", ""]);
    expect(out).toEqual([{ item: "a", score: null }, { item: "b", score: null }]);
  });
});
