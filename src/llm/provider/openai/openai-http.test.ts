import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAiHttpError,
  buildOpenAiHeaders,
  humanizeOpenAiHttpError,
  openAiPostJson,
  openAiStartStream,
  type OpenAiHttpDeps,
} from "./openai-http.js";
import { classifyFailure } from "../../reliability/classify-failure.js";

function depsWith(
  fetchImpl: typeof fetch,
  requestTimeoutMs = 60_000,
): OpenAiHttpDeps {
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
      openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        {},
        {},
      ),
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
      .mockResolvedValueOnce(
        errorResponse(429, "slow down", { "retry-after": "0" }),
      )
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

  describe("structured RetryInfo metadata", () => {
    // Gemini's OpenAI-compatible endpoint sends its cooldown only in
    // the error JSON — google.rpc.RetryInfo with a protobuf Duration
    // string — and no `retry-after` header. Fake timers plus a pinned
    // Math.random (0.5 zeroes the ±20% jitter) make every wait exact.
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function retryInfoBody(retryDelay: unknown, status = 429): string {
      return JSON.stringify({
        error: {
          code: status,
          details: [
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
          ],
        },
      });
    }

    async function expectSecondFetchAfter(
      pending: Promise<unknown>,
      fetchImpl: ReturnType<typeof vi.fn>,
      waitMs: number,
    ): Promise<void> {
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }

    it.each([
      { status: 429, retryDelay: "1.5s", expectedMs: 1_500 },
      { status: 503, retryDelay: "2s", expectedMs: 2_000 },
    ])(
      "honors error.details[].retryDelay on a headerless $status",
      async ({ status, retryDelay, expectedMs }) => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(
            errorResponse(status, retryInfoBody(retryDelay, status)),
          )
          .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const pending = openAiPostJson(
          depsWith(fetchImpl as unknown as typeof fetch),
          "/x",
          {},
          {},
        );
        await expectSecondFetchAfter(pending, fetchImpl, expectedMs);
      },
    );

    it.each(["not-a-duration", "-1s", 39])(
      "ignores unusable retryDelay %j and keeps the plain backoff",
      async (retryDelay) => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(errorResponse(429, retryInfoBody(retryDelay)))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const pending = openAiPostJson(
          depsWith(fetchImpl as unknown as typeof fetch),
          "/x",
          {},
          {},
        );
        await expectSecondFetchAfter(pending, fetchImpl, 150);
      },
    );

    it("prefers a valid retry-after header over the structured delay", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          errorResponse(429, retryInfoBody("4s"), { "retry-after": "0.5" }),
        )
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const pending = openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        {},
        {},
      );
      await expectSecondFetchAfter(pending, fetchImpl, 500);
    });

    it("caps a long structured delay like a header-declared one", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, retryInfoBody("39s")))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const pending = openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        {},
        {},
      );
      await expectSecondFetchAfter(pending, fetchImpl, 5_000);
    });

    it("reads the metadata only on throttling statuses", async () => {
      // A 500 carrying RetryInfo-shaped JSON keeps the plain backoff.
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(500, retryInfoBody("4s", 500)))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const pending = openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        {},
        {},
      );
      await expectSecondFetchAfter(pending, fetchImpl, 150);
    });

    it("lets caller cancellation interrupt the structured wait", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const controller = new AbortController();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, retryInfoBody("39s")));
      const pending = openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        {},
        { signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        status: null,
        message: "completion aborted by caller",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
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

describe("credit-limit (402) recovery", () => {
  /** The body OpenRouter actually sent in the reported session. */
  const CREDIT_BODY =
    "This request requires more credits, or fewer max_tokens. " +
    "You requested up to 65536 tokens, but can only afford 45822.";

  function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call: number) {
    const init = fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  function collectingLogger() {
    const warnings: Array<{
      message: string;
      context?: Record<string, unknown>;
    }> = [];
    return {
      warnings,
      warn(message: string, context?: Record<string, unknown>) {
        warnings.push({ message, ...(context ? { context } : {}) });
      },
    };
  }

  it("retries once with a ceiling the balance covers and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const logger = collectingLogger();
    const result = await openAiPostJson(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger },
      "/v1/chat/completions",
      { model: "m", max_tokens: 65536 },
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 0).max_tokens).toBe(65536);
    const retried = sentBody(fetchImpl, 1);
    // Strictly below what the provider said the balance covers, and the
    // rest of the request is untouched.
    expect(retried.max_tokens).toBeLessThan(45822);
    expect(retried.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(retried.model).toBe("m");
  });

  it("surfaces a second 402 instead of whittling the ceiling down again", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(402, CREDIT_BODY));
    const logger = collectingLogger();
    const err = await openAiPostJson(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger },
      "/x",
      { max_tokens: 65536 },
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(402);
    expect((err as OpenAiHttpError).message).toContain("can only afford");
    // Exactly one recovery attempt: the original plus one retry.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logger.warnings).toHaveLength(1);
  });

  it("does not retry a 402 whose body names no affordable ceiling", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(402, "Payment Required"));
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      { max_tokens: 65536 },
      {},
    ).catch((e: unknown) => e);
    expect((err as OpenAiHttpError).status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the affordable ceiling is unusably small", async () => {
    const fetchImpl = vi.fn(async () =>
      errorResponse(
        402,
        "You requested up to 65536 tokens, but can only afford 12.",
      ),
    );
    await expect(
      openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        { max_tokens: 65536 },
        {},
      ),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not read the same wording on a non-402 status as a credit problem", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(400, CREDIT_BODY));
    await expect(
      openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        { max_tokens: 65536 },
        {},
      ),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("announces the retry with the provider and both ceilings", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const logger = collectingLogger();
    await openAiPostJson(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger },
      "/x",
      { max_tokens: 65536 },
      {},
    );
    expect(logger.warnings).toHaveLength(1);
    const { message, context } = logger.warnings[0]!;
    expect(message).toContain("testprov");
    expect(message).toContain("65536");
    expect(message).toContain("45822");
    expect(message.toLowerCase()).toContain("balance");
    expect(context).toMatchObject({
      provider: "testprov",
      requestedMaxTokens: 65536,
      affordableMaxTokens: 45822,
    });
  });

  it("is never silent, even without a logger", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await openAiPostJson(
        depsWith(fetchImpl as unknown as typeof fetch),
        "/x",
        { max_tokens: 65536 },
        {},
      );
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("testprov");
      expect(written).toContain("45822");
    } finally {
      stderr.mockRestore();
    }
  });

  it("recovers the streaming open the same way", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(
        new Response(new Blob(["data: {}\n\n"]).stream(), { status: 200 }),
      );
    const logger = collectingLogger();
    const res = await openAiStartStream(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger },
      "/x",
      { max_tokens: 65536, stream: true },
      {},
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 1).max_tokens).toBeLessThan(45822);
    expect(logger.warnings).toHaveLength(1);
  });

  it("leaves the transient-failure retry budget alone", async () => {
    // A 402 spends one attempt, exactly like any other non-retryable
    // status; the recovery must not borrow from the 5xx budget.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const logger = collectingLogger();
    const result = await openAiPostJson(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger },
      "/x",
      { max_tokens: 65536 },
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("humanizeOpenAiHttpError", () => {
  const mk = (status: number | null, timedOut = false): OpenAiHttpError =>
    new OpenAiHttpError(
      "raw",
      status,
      "https://api.x.ai/v1/y",
      timedOut,
      null,
      "openrouter",
    );

  it("names the provider and the remedy per failure class", () => {
    expect(humanizeOpenAiHttpError(mk(null))).toContain(
      'Can\'t reach "openrouter"',
    );
    expect(humanizeOpenAiHttpError(mk(null))).toContain(
      "Check the provider URL",
    );
    expect(humanizeOpenAiHttpError(mk(401))).toContain(
      "rejected the API key (401)",
    );
    expect(humanizeOpenAiHttpError(mk(403))).toContain(
      "rejected the API key (403)",
    );
    expect(humanizeOpenAiHttpError(mk(404))).toContain(
      "model id or the base URL",
    );
    /* A 402 names the status and always explains the mechanism; when the
       body carries the provider's own sentence it carries that too. The
       wording moved when the desktop branch merged: "refused the request
       for lack of credit" dropped OpenRouter's own line, which is the
       one with the numbers in it. */
    expect(humanizeOpenAiHttpError(mk(402))).toContain("rejected the request (402)");
    expect(humanizeOpenAiHttpError(mk(402))).toContain("completionMaxTokens");
    expect(humanizeOpenAiHttpError(mk(402))).toContain("Top up the account");
    expect(humanizeOpenAiHttpError(mk(429))).toContain(
      "rate-limiting this key (429)",
    );
    expect(humanizeOpenAiHttpError(mk(500))).toContain("server trouble (500)");
    expect(humanizeOpenAiHttpError(mk(500))).toContain("not your setup");
    expect(humanizeOpenAiHttpError(mk(null, true))).toContain(
      "took too long to answer",
    );
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

  /* A status with no wording of its own used to end the sentence, and
     402 is the one that hurts: OpenRouter's body says, in plain English,
     that the balance covers fewer tokens than the request asked for and
     what to do about it. "rejected the request (402)" is not something
     an operator can act on; the provider's own sentence is. */
  const withBody = (status: number, body: string): OpenAiHttpError =>
    new OpenAiHttpError(
      `openai provider ${status}: ${body}`,
      status,
      "https://openrouter.ai/api/v1/chat/completions",
      false,
      null,
      "openrouter",
    );

  it("passes on the provider's own reason for a status it has no wording for", () => {
    const err = withBody(
      402,
      JSON.stringify({
        error: {
          message:
            "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 7181",
          code: 402,
        },
      }),
    );
    const said = humanizeOpenAiHttpError(err);
    expect(said).toContain('"openrouter" rejected the request (402)');
    expect(said).toContain("requires more credits, or fewer max_tokens");
  });

  /* The body is folded into the message truncated to 300 characters, so
     a real 402 arrives as a JSON object cut off mid-way. Parsing alone
     therefore fails on exactly the case this exists for. */
  it("still finds the sentence when the body was cut off mid-JSON", () => {
    const full = JSON.stringify({
      error: {
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 7166",
        code: 402,
        metadata: {
          remedy_hint:
            "Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.",
          limit_source: "openrouter_credits",
          previous_errors: [],
        },
      },
    });
    const err = withBody(402, full.slice(0, 300));
    expect(() => JSON.parse(full.slice(0, 300))).toThrow();
    const said = humanizeOpenAiHttpError(err);
    expect(said).toContain("This request requires more credits, or fewer max_tokens");
    expect(said).not.toContain('{"error"');
  });

  it("reads the shapes providers actually send, and plain text too", () => {
    expect(humanizeOpenAiHttpError(withBody(400, JSON.stringify({ message: "bad tool schema" }))))
      .toContain("bad tool schema");
    expect(humanizeOpenAiHttpError(withBody(400, JSON.stringify({ error: "unsupported" }))))
      .toContain("unsupported");
    expect(humanizeOpenAiHttpError(withBody(413, "payload too large\n"))).toContain("payload too large");
  });

  it("says only what it knows when the body carried nothing", () => {
    /* No sentence from the provider, so none is invented — but a 402 still
       explains the mechanism, because that part is true whatever the body
       said. What must NOT appear is a fabricated reason. */
    for (const body of ["", "{}"]) {
      const said = humanizeOpenAiHttpError(withBody(402, body));
      expect(said).toContain('"openrouter" rejected the request (402).');
      expect(said).toContain("completionMaxTokens");
      expect(said).not.toContain("undefined");
    }
  });

  it("bounds a provider that echoes the whole request back", () => {
    const said = humanizeOpenAiHttpError(withBody(400, JSON.stringify({ error: { message: "x".repeat(4000) } })));
    expect(said.length).toBeLessThan(300);
    expect(said.endsWith("…")).toBe(true);
  });
});

describe("classification", () => {
  it("classifies every cloud HTTP status as transport, never tool", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      const err = new OpenAiHttpError(
        `openai provider ${status}: x`,
        status,
        "u",
      );
      expect(classifyFailure(err)).toBe("transport");
    }
  });

  it("classifies cloud network failures and timeouts as transport", () => {
    expect(classifyFailure(new OpenAiHttpError("net", null, "u"))).toBe(
      "transport",
    );
    expect(
      classifyFailure(new OpenAiHttpError("timeout", null, "u", true)),
    ).toBe("transport");
  });
});

describe("buildOpenAiHeaders", () => {
  const base: OpenAiHttpDeps = {
    baseUrl: "https://api.example.com",
    apiKey: "k",
    extraHeaders: {},
    requestTimeoutMs: 1,
    fetchImpl: fetch,
    label: "p",
  };

  it("defaults to Authorization: Bearer", () => {
    expect(buildOpenAiHeaders(base, false)).toMatchObject({
      authorization: "Bearer k",
      "content-type": "application/json",
      accept: "application/json",
    });
  });

  it("moves the key into apiKeyHeader and drops Authorization entirely", () => {
    // Not "in addition to": a service that reads Authorization as an
    // OAuth token rejects the request on the stray header alone.
    const headers = buildOpenAiHeaders(
      { ...base, apiKeyHeader: "x-api-key" },
      false,
    );
    expect(headers["x-api-key"]).toBe("k");
    expect(headers.authorization).toBeUndefined();
  });

  it("sends no auth header at all for a keyless server", () => {
    // `Bearer ` with an empty token is malformed; so is an empty
    // `x-api-key`. Neither shape may be emitted.
    const headers = buildOpenAiHeaders(
      { ...base, apiKey: "", apiKeyHeader: "x-api-key" },
      false,
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("carries the entry's static headers alongside the key", () => {
    const headers = buildOpenAiHeaders(
      {
        ...base,
        apiKeyHeader: "x-api-key",
        extraHeaders: { "anthropic-version": "2023-06-01" },
      },
      true,
    );
    expect(headers).toMatchObject({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
    });
  });
});
