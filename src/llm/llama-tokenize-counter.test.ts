import { describe, expect, it, vi } from "vitest";
import { createLlamaTokenizeCounter } from "./llama-tokenize-counter.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A `/tokenize` stand-in that returns one token per whitespace-separated word. */
function wordTokenizer() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { content } = JSON.parse(String(init?.body)) as { content: string };
    return jsonResponse({ tokens: content.split(/\s+/).filter(Boolean).map((_, i) => i) });
  });
}

describe("createLlamaTokenizeCounter (ATO-656)", () => {
  it("posts the text to /tokenize on the server root and counts the tokens", async () => {
    const fetch = wordTokenizer();
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080/v1", apiKey: () => "k", fetch });
    expect(await counter.count("one two three")).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8080/tokenize");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(String(init?.body))).toEqual({ content: "one two three", add_special: false });
  });

  it("sends no authorization header without a key", async () => {
    const fetch = wordTokenizer();
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", apiKey: () => null, fetch });
    await counter.count("a b");
    expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("answers the same text from its cache and asks again for a new one", async () => {
    const fetch = wordTokenizer();
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch });
    expect(await counter.count("a b c")).toBe(3);
    expect(await counter.count("a b c")).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await counter.count("a b c d")).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a count across a model swap on the same server", async () => {
    const fetch = wordTokenizer();
    let model = "qwen";
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", modelKey: () => model, fetch });
    await counter.count("a b");
    model = "gemma";
    await counter.count("a b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past its size", async () => {
    const fetch = wordTokenizer();
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", cacheEntries: 2, fetch });
    await counter.count("a");
    await counter.count("a b");
    await counter.count("a b c");
    expect(fetch).toHaveBeenCalledTimes(3);
    await counter.count("a b c");
    expect(fetch).toHaveBeenCalledTimes(3);
    await counter.count("a");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("counts empty text as zero without a request", async () => {
    const fetch = wordTokenizer();
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch });
    expect(await counter.count("")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null on a server error and asks again next time", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "busy" }, 503));
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch });
    expect(await counter.count("a b")).toBeNull();
    expect(await counter.count("a b")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops asking a server that has no /tokenize", async () => {
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch });
    expect(await counter.count("a b")).toBeNull();
    expect(await counter.count("c d")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a body without a token array", async () => {
    const fetch = vi.fn(async () => jsonResponse({ count: 3 }));
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch });
    expect(await counter.count("a b c")).toBeNull();
    const broken = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch: vi.fn(async () => new Response("<html>", { status: 200 })) });
    expect(await broken.count("a b c")).toBeNull();
  });

  it("returns null when the server cannot be reached or the URL is invalid", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", fetch }).count("a")).toBeNull();
    const invalid = vi.fn(wordTokenizer());
    expect(await createLlamaTokenizeCounter({ baseUrl: () => "not a url", fetch: invalid }).count("a")).toBeNull();
    expect(invalid).not.toHaveBeenCalled();
  });

  it("gives up after its timeout", async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", timeoutMs: 20, fetch });
    expect(await counter.count("a b")).toBeNull();
  });

  it("follows the caller's cancellation", async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const counter = createLlamaTokenizeCounter({ baseUrl: () => "http://127.0.0.1:8080", timeoutMs: 60_000, fetch });
    const controller = new AbortController();
    const pending = counter.count("a b", controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect(await counter.count("c d", aborted.signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
