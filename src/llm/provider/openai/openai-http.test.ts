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
import { parseProviderErrorBody } from "./parse-provider-error-body.js";

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

  it("retains the upstream error type off a llama.cpp context-size refusal", async () => {
    // `body.type` is what the Sentry scrubber reads to name the failure
    // (`upstream_error_type`): the message never travels, so this field
    // is the only thing that says *why* a provider refused a turn.
    // The body is llama.cpp's own shape — `ERROR_TYPE_EXCEED_CONTEXT_SIZE`
    // answered as a 400, per the strings in the llama-server build this
    // project ships — driven through the real HTTP path rather than a
    // hand-built error object.
    const fetchImpl = vi.fn(async () =>
      errorResponse(
        400,
        JSON.stringify({
          error: {
            code: 400,
            message:
              "the request exceeds the available context size, try increasing it",
            type: "exceed_context_size_error",
          },
        }),
        { "content-type": "application/json" },
      ),
    );
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/v1/chat/completions",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).body?.type).toBe(
      "exceed_context_size_error",
    );
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

  it("does not retry a 429 whose body says the credit is exhausted, and keeps the body", async () => {
    // Retried 42 times per worker in the field, as if it were throttling.
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: {
          raw: '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low"}}',
        },
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(errorResponse(429, body, { "retry-after": "0" }));
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((err as OpenAiHttpError).body).toMatchObject({
      message: "Provider returned error",
      code: "429",
    });
    expect((err as OpenAiHttpError).body?.text).toContain(
      "credit_balance_exhausted",
    );
  });

  it("does not retry a 429 whose words say the account is empty (item 40)", async () => {
    const body = JSON.stringify({
      error: {
        message:
          "Your account is suspended due to insufficient balance, please recharge your account",
        type: "exceeded_current_quota_error",
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(429, body));
    const err = await openAiPostJson(
      depsWith(fetchImpl as unknown as typeof fetch),
      "/x",
      {},
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("tells the caller which body each attempt went out with", async () => {
    // A truncation is judged against the cap the response ran under, and
    // after a 402 that is the lowered one, not the one the caller built.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, CREDIT_BODY))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sent: Array<Record<string, unknown>> = [];
    await openAiPostJson(
      { ...depsWith(fetchImpl as unknown as typeof fetch), logger: collectingLogger() },
      "/x",
      { max_tokens: 65536 },
      {},
      (body) => sent.push(body),
    );
    // Exactly the bodies that went on the wire, in order — the second one
    // carrying the lowered cap the retry chose.
    const onTheWire = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
    );
    expect(sent).toEqual(onTheWire);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.max_tokens).toBe(65536);
    expect(sent[1]!.max_tokens).toBeLessThan(65536);
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

  it("words a failure reported inside a 200 stream without a retry count or a borrowed status", () => {
    const streamed = (status: number | null, streamError: string) =>
      new OpenAiHttpError(
        "raw",
        status,
        "https://api.x.ai/v1/y",
        false,
        null,
        "fake",
        undefined,
        { streamError },
      );
    const finish = humanizeOpenAiHttpError(
      streamed(502, "the provider ended the completion with an error (MALFORMED_FUNCTION_CALL)"),
    );
    expect(finish).toBe(
      '"fake" ended its reply with an error (MALFORMED_FUNCTION_CALL) — this is on the provider, not your setup.',
    );
    expect(
      humanizeOpenAiHttpError(streamed(502, "the provider ended the completion with an error")),
    ).toBe('"fake" ended its reply with an error — this is on the provider, not your setup.');
    expect(humanizeOpenAiHttpError(streamed(504, "Upstream idle timeout"))).toBe(
      '"fake" reported an error in the middle of its reply (504): Upstream idle timeout',
    );
    expect(humanizeOpenAiHttpError(streamed(null, "stream error"))).toBe(
      '"fake" reported an error in the middle of its reply: stream error',
    );
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

  /* Google's OpenAI-compatible surface wraps its error object in an array.
     It parsed, carried no top-level message, and the sentence was dropped:
     a bad Gemini key read only "rejected the request (400)." */
  it("reads the sentence out of Gemini's array-wrapped error", () => {
    const body =
      '[{\n  "error": {\n    "code": 400,\n    "message": "Please pass a valid API key",\n    "status": "INVALID_ARGUMENT"\n  }\n}\n]';
    const said = humanizeOpenAiHttpError(withBody(400, body));
    expect(said).toContain("rejected the request (400). Please pass a valid API key");
    expect(said).not.toContain('"error"');
  });

  /* Item 40: a refusal because the account cannot pay names the provider,
     quotes its own first sentence (links cut to their domain) and says
     what helps. AI/ML API's 403 read "rejected the API key (403)", and
     OpenAI's 429 insufficient_quota read as rate limiting, "Tried 3
     times", for a request that was never retried. */
  describe("a refusal because the account cannot pay", () => {
    const aiml = (body: string): OpenAiHttpError =>
      new OpenAiHttpError(
        `openai provider 403: ${body}`,
        403,
        "https://api.aimlapi.com/v1/chat/completions",
        false,
        null,
        "aimlapi",
        undefined,
        { body: parseProviderErrorBody(body) },
      );

    it("says AI/ML API's 403 in its own words, with the remedy", () => {
      const said = humanizeOpenAiHttpError(
        aiml(
          JSON.stringify({
            title: "Forbidden",
            status: 403,
            message:
              "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
          }),
        ),
      );
      expect(said).toBe(
        "AI/ML API refused the request: you've run out of funds. Top up your balance with AI/ML API or pick another provider in the Providers panel.",
      );
      expect(said).not.toContain("API key");
    });

    it("names a preset or a numbered entry by its service, and quotes an id it does not know", () => {
      const body = JSON.stringify({ error: { message: "Insufficient Balance" } });
      const as = (label: string): string =>
        humanizeOpenAiHttpError(
          new OpenAiHttpError(`openai provider 403: ${body}`, 403, "https://api.example.com/v1/chat/completions", false, null, label, undefined, {
            body: parseProviderErrorBody(body),
          }),
        );
      expect(as("deepseek")).toMatch(/^DeepSeek refused the request: insufficient Balance\. Top up your balance with DeepSeek /);
      expect(as("aimlapi-2")).toMatch(/^AI\/ML API refused the request/);
      expect(as("dashscope")).toMatch(/^Qwen refused the request/);
      expect(as("my-proxy")).toMatch(/^"my-proxy" refused the request/);
    });

    /* OpenRouter relays the upstream vendor's refusal (a key of the user's
       own at that vendor) as "Provider returned error", with the vendor's
       body in metadata.raw: the F29 case. */
    it("quotes the upstream vendor OpenRouter relays, and sends the top-up there", () => {
      const relayed = (metadata: Record<string, unknown>): string => {
        const body = JSON.stringify({ error: { message: "Provider returned error", code: 429, metadata } });
        return humanizeOpenAiHttpError(
          new OpenAiHttpError(`openai provider 429: ${body}`, 429, "https://openrouter.ai/api/v1/chat/completions", false, null, "openrouter", undefined, {
            body: parseProviderErrorBody(body),
          }),
        );
      };
      const raw =
        '{"type":"error","error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
      expect(relayed({ provider_name: "Anthropic", raw })).toBe(
        "OpenRouter refused the request: Anthropic says your credit balance is too low to access the Anthropic API. Top up your balance with Anthropic or pick another provider in the Providers panel.",
      );
      expect(relayed({ raw })).toBe(
        "OpenRouter refused the request: your credit balance is too low to access the Anthropic API. Top up your balance with the provider behind OpenRouter or pick another provider in the Providers panel.",
      );
      expect(relayed({ provider_name: "Anthropic", raw })).not.toContain("provider returned error");
    });

    it("cuts a link in the quoted sentence to its domain", () => {
      const said = humanizeOpenAiHttpError(
        aiml(
          JSON.stringify({
            error: { message: "No funds left, add some at https://www.example.com/billing/top-up?ref=x" },
          }),
        ),
      );
      expect(said).toContain("refused the request: no funds left, add some at example.com.");
      expect(said).not.toContain("https://");
    });

    it("words OpenAI's 429 insufficient_quota as the account, not a rate limit", () => {
      const body = JSON.stringify({
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      });
      const said = humanizeOpenAiHttpError(
        new OpenAiHttpError(
          `openai provider 429: ${body}`,
          429,
          "https://api.openai.com/v1/chat/completions",
          false,
          null,
          "openai",
          undefined,
          { body: parseProviderErrorBody(body) },
        ),
      );
      expect(said).toBe(
        '"openai" refused the request: you exceeded your current quota, please check your plan and billing details. Top up your balance with "openai" or pick another provider in the Providers panel.',
      );
      expect(said).not.toContain("rate-limiting");
      expect(said).not.toContain("Tried");
    });

    it("says a moderation 403 is the provider's filter, not the key", () => {
      const body = JSON.stringify({
        error: {
          code: 403,
          message:
            'openai/gpt-4o requires moderation on OpenRouter. Your input was flagged for "harassment"',
          metadata: {
            reasons: ["harassment"],
            flagged_input: "...",
            provider_name: "OpenAI",
            model_slug: "openai/gpt-4o",
          },
        },
      });
      const said = humanizeOpenAiHttpError(
        new OpenAiHttpError(`openai provider 403: ${body}`, 403, "https://openrouter.ai/api/v1/chat/completions", false, null, "openrouter", undefined, {
          body: parseProviderErrorBody(body),
        }),
      );
      expect(said).toContain('"openrouter" refused the request (403): its moderation flagged the input');
      expect(said).toContain('Your input was flagged for "harassment"');
      expect(said).not.toContain("API key");
      // A 403 with no body is still the key's.
      expect(humanizeOpenAiHttpError(mk(403))).toContain("rejected the API key (403)");
    });

    it("keeps Gemini's per-minute 429 a rate limit, billing words and all", () => {
      const body = JSON.stringify([
        {
          error: {
            code: 429,
            message:
              "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 41.6s.",
            status: "RESOURCE_EXHAUSTED",
          },
        },
      ]);
      const said = humanizeOpenAiHttpError(
        new OpenAiHttpError(`openai provider 429: ${body}`, 429, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", false, 41_600, "gemini", undefined, {
          body: parseProviderErrorBody(body),
        }),
      );
      expect(said).toContain("rate-limiting this key (429)");
      expect(said).not.toMatch(/top up|refused the request/i);
    });

    it("leaves a 403 about the key and a plain 429 as they were", () => {
      expect(
        humanizeOpenAiHttpError(aiml(JSON.stringify({ error: { message: "Invalid API key" } }))),
      ).toContain("rejected the API key (403)");
      expect(humanizeOpenAiHttpError(mk(429))).toContain("rate-limiting this key (429)");
    });
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

describe("a key problem the request itself shows", () => {
  const caught = async (run: () => Promise<unknown>): Promise<OpenAiHttpError> => {
    try {
      await run();
    } catch (err) {
      if (err instanceof OpenAiHttpError) return err;
      throw err;
    }
    throw new Error("expected an OpenAiHttpError");
  };

  it("a key with a non-ASCII character was never sent, and the message says so", async () => {
    const fetchImpl = vi.fn();
    const err = await caught(() =>
      openAiPostJson(
        { ...depsWith(fetchImpl as unknown as typeof fetch), apiKey: "sk-ключ", label: "aimlapi" },
        "/v1/chat/completions",
        {},
        {},
      ),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err.status).toBe(401);
    expect(err.keyProblem).toBe("non_ascii");
    expect(humanizeOpenAiHttpError(err)).toBe(
      '"aimlapi" can\'t use its API key: the key has a character API keys never contain (often a letter or quote picked up while pasting), so it was not sent. Re-enter the key in the Providers panel.',
    );
  });

  it("a 401 to a request that carried no key says no key is set", async () => {
    const err = await caught(() =>
      openAiPostJson(
        {
          ...depsWith(async () => errorResponse(401, '{"error":{"message":"You didn\'t provide an API key."}}')),
          apiKey: "",
          label: "dashscope",
        },
        "/v1/chat/completions",
        {},
        {},
      ),
    );
    expect(err.keyProblem).toBe("missing");
    expect(humanizeOpenAiHttpError(err)).toBe(
      '"dashscope" needs an API key and none is set. Add the key in the Providers panel.',
    );
  });

  it("a 401 to a key that was sent stays the provider's refusal", async () => {
    const err = await caught(() =>
      openAiPostJson(
        depsWith(async () => errorResponse(401, "invalid key")),
        "/v1/chat/completions",
        {},
        {},
      ),
    );
    expect(err.keyProblem).toBeUndefined();
    expect(humanizeOpenAiHttpError(err)).toContain("rejected the API key (401)");
  });

  it("a key set by hand in the entry's headers counts as sent", async () => {
    for (const extraHeaders of [
      { Authorization: "Bearer sk-by-hand" },
      { "x-goog-api-key": "AIza-by-hand" },
    ]) {
      const err = await caught(() =>
        openAiPostJson(
          {
            ...depsWith(async () => errorResponse(403, "forbidden")),
            apiKey: "",
            extraHeaders,
          },
          "/v1/chat/completions",
          {},
          {},
        ),
      );
      expect(err.keyProblem).toBeUndefined();
    }
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
