import { describe, expect, it, vi } from "vitest";

import {
  OpenAiHttpError,
  humanizeOpenAiHttpError,
  openAiPostJson,
  openAiStartStream,
  type OpenAiHttpDeps,
} from "./openai-http.js";
import { classifyFailure } from "../../reliability/classify-failure.js";

function depsWith(fetchImpl: typeof fetch, requestTimeoutMs = 60_000): OpenAiHttpDeps {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "key",
    extraHeaders: {},
    requestTimeoutMs,
    fetchImpl,
    label: "testprov",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  body = "boom",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("openAiPostJson", () => {
  it("returns parsed JSON on success without retrying", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/v1/chat/completions",
      {},
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws OpenAiHttpError carrying the status and body preview", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(401, "bad key"));
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/v1/chat/completions",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(401);
    expect((err as OpenAiHttpError).message).toContain("openai provider 401");
    expect((err as OpenAiHttpError).message).toContain("bad key");
  });

  it("does not retry deterministic 4xx failures", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(401));
    await expect(
      openAiPostJson(depsWith(fetchImpl as unknown as typeof fetch), "/x", {}, {}),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry budget and throws the last error", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(500, "still down"));
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries 429 and reads retry-after into the error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "slow down", { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("wraps network failures as status null and retries them", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks our own timeout as timedOut and does not retry it", async () => {
    // fetch honors the abort signal armed by the 0ms request timeout.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch, 1),
      "/x",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).timedOut).toBe(true);
    expect((err as OpenAiHttpError).status).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rethrows caller aborts untouched so they stay cancellations", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const pending = openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      { signal: controller.signal },
    ).catch((e: unknown) => e);
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(OpenAiHttpError);
    expect((err as Error).name).toBe("AbortError");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("openAiStartStream", () => {
  it("retries a failed stream open before any chunk exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(
        new Response(new Blob(["data: {}\n\n"]).stream(), { status: 200 }),
      );
    const res = await openAiStartStream(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.body).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a 2xx without a body as a provider failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const err = await openAiStartStream(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
  });
});

describe("humanizeOpenAiHttpError", () => {
  const mk = (
    status: number | null,
    timedOut = false,
  ): OpenAiHttpError =>
    new OpenAiHttpError("raw", status, "https://api.x.ai/v1/y", timedOut, null, "openrouter");

  it("names the provider and the remedy per failure class", () => {
    expect(humanizeOpenAiHttpError(mk(null))).toContain('Can\'t reach "openrouter"');
    expect(humanizeOpenAiHttpError(mk(null))).toContain("Check the provider URL");
    expect(humanizeOpenAiHttpError(mk(401))).toContain("rejected the API key (401)");
    expect(humanizeOpenAiHttpError(mk(403))).toContain("rejected the API key (403)");
    expect(humanizeOpenAiHttpError(mk(404))).toContain("model id or the base URL");
    expect(humanizeOpenAiHttpError(mk(429))).toContain("rate-limiting this key (429)");
    expect(humanizeOpenAiHttpError(mk(500))).toContain("server trouble (500)");
    expect(humanizeOpenAiHttpError(mk(500))).toContain("not your setup");
    expect(humanizeOpenAiHttpError(mk(null, true))).toContain("took too long to answer");
  });

  it("claims a retry count only for classes the client retries", () => {
    expect(humanizeOpenAiHttpError(mk(401))).not.toContain("Tried");
    expect(humanizeOpenAiHttpError(mk(404))).not.toContain("Tried");
    expect(humanizeOpenAiHttpError(mk(null, true))).not.toContain("Tried");
    expect(humanizeOpenAiHttpError(mk(429))).toContain("Tried 3 times");
    expect(humanizeOpenAiHttpError(mk(500))).toContain("Tried 3 times");
    expect(humanizeOpenAiHttpError(mk(null))).toContain("Tried 3 times");
  });

  it("falls back to the host when no provider label is set", () => {
    const err = new OpenAiHttpError("raw", 500, "https://api.x.ai/v1/y");
    expect(humanizeOpenAiHttpError(err)).toContain('"api.x.ai"');
  });
});

describe("classification", () => {
  it("classifies every cloud HTTP status as transport, never tool", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      const err = new OpenAiHttpError(`openai provider ${status}: x`, status, "u");
      expect(classifyFailure(err)).toBe("transport");
    }
  });

  it("classifies cloud network failures and timeouts as transport", () => {
    expect(classifyFailure(new OpenAiHttpError("net", null, "u"))).toBe("transport");
    expect(classifyFailure(new OpenAiHttpError("timeout", null, "u", true))).toBe(
      "transport",
    );
  });
});
