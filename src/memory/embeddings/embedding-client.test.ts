import { describe, expect, it } from "vitest";

import {
  EmbeddingUnavailableError,
  LlamaEmbeddingClient,
} from "./embedding-client.js";

describe("LlamaEmbeddingClient", () => {
  function makeFetch(
    handler: (req: { url: string; body: unknown }) => Response,
  ): typeof fetch {
    return async (
      input: string | URL | globalThis.Request,
      init?: globalThis.RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body
        ? JSON.parse(init.body as string)
        : null;
      return handler({ url, body });
    };
  }

  it("rejects non-positive dim at construction", () => {
    expect(
      () =>
        new LlamaEmbeddingClient({
          url: "http://x",
          dim: 0,
          model: "m",
        }),
    ).toThrow(/dim must be a positive integer/);
    expect(
      () =>
        new LlamaEmbeddingClient({
          url: "http://x",
          dim: 1.5,
          model: "m",
        }),
    ).toThrow(/dim must be a positive integer/);
  });

  it("posts to /embedding and parses { embedding: number[] }", async () => {
    const fetchFn = makeFetch(({ url, body }) => {
      expect(url).toBe("http://127.0.0.1:9999/embedding");
      expect(body).toEqual({ content: "hello" });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new LlamaEmbeddingClient({
      url: "http://127.0.0.1:9999/",
      dim: 3,
      model: "test-model",
      fetch: fetchFn,
    });
    const r = await c.embed({ text: "hello" });
    expect(r.model).toBe("test-model");
    expect(Array.from(r.vector)).toHaveLength(3);
    expect(r.vector[0]).toBeCloseTo(0.1, 6);
  });

  it("accepts nested { embedding: number[][] } shape", async () => {
    const fetchFn = makeFetch(
      () =>
        new Response(
          JSON.stringify({ embedding: [[1, 2, 3]] }),
          { status: 200 },
        ),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    const r = await c.embed({ text: "x" });
    expect(Array.from(r.vector)).toEqual([1, 2, 3]);
  });

  it("accepts OpenAI-shape { data: [{ embedding }] }", async () => {
    const fetchFn = makeFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.5, 0.5, 0.5] }] }),
          { status: 200 },
        ),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    const r = await c.embed({ text: "x" });
    expect(Array.from(r.vector)).toEqual([0.5, 0.5, 0.5]);
  });

  it("accepts current llama.cpp top-level array shape [{ index, embedding: [[...]] }]", async () => {
    // Variant (D) from `extractEmbeddingArray`. Observed against live
    // llama.cpp with --embeddings + a BGE GGUF: the response is a
    // top-level array even for a single input, with embedding nested.
    const fetchFn = makeFetch(
      () =>
        new Response(
          JSON.stringify([{ index: 0, embedding: [[4, 5, 6]] }]),
          { status: 200 },
        ),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    const r = await c.embed({ text: "x" });
    expect(Array.from(r.vector)).toEqual([4, 5, 6]);
  });

  it("accepts top-level array with flat embedding [{ index, embedding: [...] }]", async () => {
    // Defensive: same variant (D) but embedding is flat rather than nested.
    const fetchFn = makeFetch(
      () =>
        new Response(
          JSON.stringify([{ index: 0, embedding: [7, 8, 9] }]),
          { status: 200 },
        ),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    const r = await c.embed({ text: "x" });
    expect(Array.from(r.vector)).toEqual([7, 8, 9]);
  });

  it("rejects empty top-level array as unrecognised shape", async () => {
    const fetchFn = makeFetch(
      () => new Response(JSON.stringify([]), { status: 200 }),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    await expect(c.embed({ text: "x" })).rejects.toThrow(/shape unrecognised/);
  });

  it("throws EmbeddingUnavailableError on HTTP 5xx", async () => {
    const fetchFn = makeFetch(
      () => new Response("backend exploded", { status: 502 }),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    await expect(c.embed({ text: "x" })).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
  });

  it("throws EmbeddingUnavailableError on dim mismatch", async () => {
    const fetchFn = makeFetch(
      () =>
        new Response(JSON.stringify({ embedding: [1, 2] }), { status: 200 }),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    await expect(c.embed({ text: "x" })).rejects.toThrow(/dim mismatch/);
  });

  it("wraps network errors as EmbeddingUnavailableError", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    await expect(c.embed({ text: "x" })).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
  });

  it("throws EmbeddingUnavailableError on unrecognised body shape", async () => {
    const fetchFn = makeFetch(
      () => new Response(JSON.stringify({ noop: true }), { status: 200 }),
    );
    const c = new LlamaEmbeddingClient({
      url: "http://x",
      dim: 3,
      model: "m",
      fetch: fetchFn,
    });
    await expect(c.embed({ text: "x" })).rejects.toThrow(/shape unrecognised/);
  });
});
