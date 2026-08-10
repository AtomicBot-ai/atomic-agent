export type OpenAiHttpDeps = {
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
};

/**
 * Typed failure for the OpenAI-compatible HTTP path, mirroring
 * `LlamaServerError` so the reliability classifier can tell provider
 * failures apart from our own tool bugs (which is where untyped cloud
 * errors used to land).
 *
 *  - HTTP error responses carry `status` plus a bounded body preview.
 *  - Network-level failures (fetch threw) carry `status === null`.
 *  - `timedOut` marks our *own* `requestTimeoutMs` controller firing, as
 *    opposed to the transport failing or the caller cancelling. Both
 *    surface as aborts, but a timeout is "the provider is slower than
 *    the budget" — replaying it just burns another full timeout.
 *  - `retryAfterMs` is populated from a `retry-after` header when the
 *    provider sent one (429/503), so the retry loop can honor it.
 */
export class OpenAiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
    public readonly timedOut = false,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "OpenAiHttpError";
  }
}

/** Cap on how much of an error body we fold into the message. */
const OPENAI_ERROR_DETAIL_MAX_LEN = 300;

/**
 * Bounded retry budget for transient failures, mirroring the llama
 * client's defaults (`localModels.completionRetries` = 3, 150ms base).
 * Deliberately not config-driven yet: the knob can follow once the
 * fallback work settles where such settings live for cloud providers.
 */
const OPENAI_MAX_ATTEMPTS = 3;
const OPENAI_BACKOFF_BASE_MS = 150;
/**
 * Ceiling on how long a provider's `retry-after` can stall one attempt.
 * Interactive turns cannot absorb a "come back in 60s" wait; a provider
 * asking for more than this gets the capped wait and then the next
 * attempt (or the typed error, which the caller can act on).
 */
const OPENAI_RETRY_AFTER_CAP_MS = 5_000;

export function buildOpenAiHeaders(
  deps: OpenAiHttpDeps,
  stream: boolean,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    // Keyless servers (a local LM Studio, an unauthenticated vLLM) get no
    // authorization header at all: `Bearer ` with an empty token is
    // malformed and some proxies reject it outright.
    ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
    ...deps.extraHeaders,
  };
}

export async function openAiGetJson(
  deps: OpenAiHttpDeps,
  path: string,
): Promise<Record<string, unknown>> {
  return runOpenAiWithRetry(deps, path, undefined, async () => {
    const res = await openAiFetch(deps, path, null, {}, false, "GET");
    if (!res.ok) {
      throw await httpErrorFromResponse(deps, path, res);
    }
    return (await res.json()) as Record<string, unknown>;
  });
}

export async function openAiPostJson(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown>,
  request: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return runOpenAiWithRetry(deps, path, request.signal, async () => {
    const res = await openAiFetch(deps, path, body, request, false, "POST");
    if (!res.ok) {
      throw await httpErrorFromResponse(deps, path, res);
    }
    return (await res.json()) as Record<string, unknown>;
  });
}

/**
 * Open a streaming completion and return the raw `Response` once the
 * server has answered 2xx with a body. Failures to *open* the stream —
 * connection errors, 429s, 5xxs — happen entirely inside the retry
 * loop, before the caller has consumed a single chunk, so retrying here
 * can never duplicate output. Once this resolves, the stream is live
 * and failures downstream are not retryable at this layer.
 */
export async function openAiStartStream(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown>,
  request: { signal?: AbortSignal },
): Promise<Response & { body: NonNullable<Response["body"]> }> {
  return runOpenAiWithRetry(deps, path, request.signal, async () => {
    const res = await openAiFetch(deps, path, body, request, true, "POST");
    if (!res.ok || !res.body) {
      throw await httpErrorFromResponse(deps, path, res);
    }
    return res as Response & { body: NonNullable<Response["body"]> };
  });
}

export async function openAiFetch(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown> | null,
  request: { signal?: AbortSignal },
  stream: boolean,
  method: "GET" | "POST" = "POST",
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.requestTimeoutMs);
  const externalSignal = request.signal;
  const onAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    return await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method,
      headers: buildOpenAiHeaders(deps, stream),
      ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    // Caller cancellation must stay a cancellation — rethrow untouched
    // so the classifier keeps reporting it as `cancelled`, not as a
    // provider failure.
    if (externalSignal?.aborted) throw err;
    if (timedOut) {
      throw new OpenAiHttpError(
        `openai provider timed out after ${deps.requestTimeoutMs}ms: ${deps.baseUrl}${path}`,
        null,
        `${deps.baseUrl}${path}`,
        true,
      );
    }
    // fetch threw without an HTTP response: DNS failure, refused
    // connection, TLS error, socket reset.
    const detail = err instanceof Error ? err.message : String(err);
    throw new OpenAiHttpError(
      `openai provider network error: ${detail}`,
      null,
      `${deps.baseUrl}${path}`,
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

async function httpErrorFromResponse(
  deps: OpenAiHttpDeps,
  path: string,
  res: Response,
): Promise<OpenAiHttpError> {
  const text = await res.text().catch(() => "");
  return new OpenAiHttpError(
    `openai provider ${res.status}: ${text.slice(0, OPENAI_ERROR_DETAIL_MAX_LEN)}`,
    res.status,
    `${deps.baseUrl}${path}`,
    false,
    parseRetryAfterMs(res.headers.get("retry-after")),
  );
}

/**
 * Transient failures worth another attempt: network blips (status null,
 * but never our own timeout — replaying one burns another full budget),
 * server errors, throttling, and request timeouts the *server* reported.
 * Auth and request-shape errors (401/403/404/400) are deterministic;
 * retrying them only delays the real message to the user.
 */
function isRetryableOpenAiError(err: unknown): boolean {
  if (!(err instanceof OpenAiHttpError)) return false;
  if (err.timedOut) return false;
  if (err.status === null) return true;
  return err.status >= 500 || err.status === 429 || err.status === 408;
}

async function runOpenAiWithRetry<T>(
  deps: OpenAiHttpDeps,
  path: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= OPENAI_MAX_ATTEMPTS; i += 1) {
    if (signal?.aborted) {
      throw new OpenAiHttpError(
        "completion aborted by caller",
        null,
        `${deps.baseUrl}${path}`,
      );
    }
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      // A caller-triggered abort is never retryable, whatever shape it
      // surfaced as.
      if (signal?.aborted) throw err;
      if (!isRetryableOpenAiError(err) || i >= OPENAI_MAX_ATTEMPTS) throw err;
      await sleep(resolveWaitMs(err, i), signal);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Wait between attempts: exponential backoff with ±20% jitter (matching
 * the llama client), stretched to a provider-requested `retry-after`
 * when one was sent — capped so a long server-side cooldown cannot
 * stall an interactive turn.
 */
function resolveWaitMs(err: unknown, attemptNumber: number): number {
  const exp = OPENAI_BACKOFF_BASE_MS * Math.pow(2, attemptNumber - 1);
  const jitter = exp * (Math.random() * 0.4 - 0.2);
  const backoff = Math.max(0, Math.round(exp + jitter));
  const retryAfter =
    err instanceof OpenAiHttpError && err.retryAfterMs !== null
      ? Math.min(err.retryAfterMs, OPENAI_RETRY_AFTER_CAP_MS)
      : 0;
  return Math.max(backoff, retryAfter);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
