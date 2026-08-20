import { buildOpenAiAuthHeaders } from "./openai-auth-headers.js";

export type OpenAiHttpDeps = {
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  /**
   * Header that carries the API key when the service does not accept
   * `Authorization: Bearer` (Anthropic wants `x-api-key`). Absent keeps
   * the OpenAI convention. See `openai-auth-headers.ts`.
   */
  apiKeyHeader?: string;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  /** Provider id shown in user-facing failure messages ("openrouter"). */
  label: string;
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
    /** Provider id for user-facing wording; falls back to the host. */
    public readonly providerLabel = "",
  ) {
    super(message);
    this.name = "OpenAiHttpError";
  }
}

/**
 * Turn a typed cloud failure into the sentence a user should read in
 * chat: who failed, what happened, what to do about it. The raw
 * technical message stays on the error itself for logs. Wording follows
 * "provider + condition + remedy"; the retry count is only claimed for
 * classes the client actually retries.
 */
export function humanizeOpenAiHttpError(err: OpenAiHttpError): string {
  const who = `"${err.providerLabel || hostOf(err.url)}"`;
  if (err.timedOut) {
    return `${who} took too long to answer and the request was stopped.`;
  }
  if (err.status === null) {
    return (
      `Can't reach ${who} — no response from ${hostOf(err.url)}. ` +
      `Tried ${OPENAI_MAX_ATTEMPTS} times. Check the provider URL or your connection.`
    );
  }
  if (err.status === 401 || err.status === 403) {
    return `${who} rejected the API key (${err.status}). Check the key in the Providers panel.`;
  }
  if (err.status === 404) {
    return `${who} answered 404 (not found). The model id or the base URL is likely wrong.`;
  }
  if (err.status === 429) {
    return `${who} is rate-limiting this key (429). Tried ${OPENAI_MAX_ATTEMPTS} times — wait a minute and retry.`;
  }
  if (err.status >= 500) {
    return `${who} is having server trouble (${err.status}). Tried ${OPENAI_MAX_ATTEMPTS} times — this is on the provider, not your setup.`;
  }
  return `${who} rejected the request (${err.status}).`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
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
    // Auth (and any service-mandated static headers) come from the one
    // builder model discovery also uses, so the two request paths cannot
    // disagree about how this endpoint is authenticated.
    ...buildOpenAiAuthHeaders(deps.apiKey, {
      ...(deps.apiKeyHeader ? { apiKeyHeader: deps.apiKeyHeader } : {}),
      headers: deps.extraHeaders,
    }),
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
  // Built before the try below, which would wrap the throw as a
  // retryable "network error" and replace its message with a
  // connectivity hint. Classified as a 401 instead: a key that cannot
  // form a header is the same class as a dead key — deterministic, never
  // retried, and a fallback chain advances past it to a link whose key
  // may work.
  let headers: Record<string, string>;
  try {
    headers = buildOpenAiHeaders(deps, stream);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new OpenAiHttpError(
      detail,
      401,
      `${deps.baseUrl}${path}`,
      false,
      null,
      deps.label,
    );
  }
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
      headers,
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
        null,
        deps.label,
      );
    }
    // fetch threw without an HTTP response: DNS failure, refused
    // connection, TLS error, socket reset.
    const detail = err instanceof Error ? err.message : String(err);
    throw new OpenAiHttpError(
      `openai provider network error: ${detail}`,
      null,
      `${deps.baseUrl}${path}`,
      false,
      null,
      deps.label,
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
    deps.label,
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
