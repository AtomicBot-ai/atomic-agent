import { buildOpenAiAuthHeaders } from "./openai-auth-headers.js";
import { readErrnoCode } from "../../errno-code.js";

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
 *    provider sent one (429/503), falling back to structured
 *    `RetryInfo` metadata in the error body, so the retry loop can
 *    honor the provider's cooldown either way.
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
    /**
     * Errno of the underlying failure (`ECONNREFUSED`, `ENOTFOUND`,
     * `UND_ERR_*`, …) when the transport left one behind. A cloud
     * provider that is unreachable and one that refused the request
     * both arrive with `status === null`; this is what tells them
     * apart in a postmortem.
     */
    public readonly code: string | undefined = undefined,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "OpenAiHttpError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
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
 *
 * Exported because it is the budget for *one* streaming completion, not
 * just for one HTTP call: `OpenAiProvider.completeStream` reopens a
 * stream that died before its first chunk, and that reopen comes out of
 * this same budget — see `OpenAiAttemptBudget`, which is what actually
 * makes the sharing true rather than merely intended.
 */
export const OPENAI_MAX_ATTEMPTS = 3;

/**
 * The remaining attempts of ONE logical completion, carried across the
 * calls that make it up.
 *
 * Without this, "shared budget" is a sentence in a comment and nothing
 * else: every `openAiStartStream` call opens a fresh `runOpenAiWithRetry`
 * loop with a fresh count, so a `completeStream` that reopens a dead
 * stream three times, each reopen paying for two 500s first, issues
 * 3 x 3 = 9 requests for one turn. That is nine billable prompt
 * submissions and, on a reasoning model that thinks for a minute before
 * dropping, minutes of frozen UI.
 *
 * The budget is a mutable counter rather than a number passed down and
 * returned because the spending happens inside the retry loop and has to
 * stay visible to the caller even when that loop throws.
 */
export interface OpenAiAttemptBudget {
  /** Attempts still available. Decremented once per HTTP request made. */
  remaining: number;
}

/** A budget for one logical completion: the full `OPENAI_MAX_ATTEMPTS`. */
export function createOpenAiAttemptBudget(): OpenAiAttemptBudget {
  return { remaining: OPENAI_MAX_ATTEMPTS };
}
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
 * and failures downstream are not retryable at this layer — the caller
 * owns that window. `OpenAiProvider.completeStream` extends the same
 * "nothing emitted yet, so a replay is free" argument a little further
 * by reopening when the body dies before its first chunk.
 *
 * Pass `budget` to make those reopens share one completion's attempts
 * with the opens: without it each call starts a fresh count and the two
 * layers multiply instead of adding.
 */
export async function openAiStartStream(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown>,
  request: { signal?: AbortSignal },
  budget?: OpenAiAttemptBudget,
): Promise<Response & { body: NonNullable<Response["body"]> }> {
  return runOpenAiWithRetry(deps, path, request.signal, async () => {
    const res = await openAiFetch(deps, path, body, request, true, "POST");
    if (!res.ok || !res.body) {
      throw await httpErrorFromResponse(deps, path, res);
    }
    return res as Response & { body: NonNullable<Response["body"]> };
  }, budget);
}

/**
 * Wait exactly as long as `runOpenAiWithRetry` would wait before its
 * next try — same exponential base, same ±20% jitter, same abort-aware
 * sleep. Exported so the one retry that lives *outside* this file
 * (`OpenAiProvider.completeStream` reopening a stream that died before
 * its first chunk) reuses this client's pacing instead of inventing a
 * second set of magic numbers. `attemptNumber` is the 1-based count of
 * requests this completion has already made, so the delay keeps growing
 * across the open/reopen seam instead of restarting at the base.
 */
export async function openAiRetryBackoff(
  attemptNumber: number,
  signal?: AbortSignal,
): Promise<void> {
  // `null` as the error: a body-read death carries no `retry-after`, so
  // only the plain backoff applies.
  await sleep(resolveWaitMs(null, attemptNumber), signal);
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
        undefined,
        { cause: err },
      );
    }
    // fetch threw without an HTTP response: DNS failure, refused
    // connection, TLS error, socket reset. Which of those it was lives
    // in the errno — keep it, and the original error with it.
    const detail = err instanceof Error ? err.message : String(err);
    throw new OpenAiHttpError(
      `openai provider network error: ${detail}`,
      null,
      `${deps.baseUrl}${path}`,
      false,
      null,
      deps.label,
      readErrnoCode(err),
      { cause: err },
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
  // The standard `retry-after` header wins; some providers advertise
  // their cooldown only inside the error JSON (Gemini's OpenAI-compat
  // endpoint sends `google.rpc.RetryInfo` and no header), so fall back
  // to that for the throttling statuses the retry loop honors.
  const retryAfterMs =
    parseRetryAfterMs(res.headers.get("retry-after")) ??
    (res.status === 429 || res.status === 503
      ? parseRetryInfoDelayMs(text)
      : null);
  return new OpenAiHttpError(
    `openai provider ${res.status}: ${text.slice(0, OPENAI_ERROR_DETAIL_MAX_LEN)}`,
    res.status,
    `${deps.baseUrl}${path}`,
    false,
    retryAfterMs,
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

/**
 * Run `attempt` under the bounded retry policy, spending `budget`.
 *
 * A caller that does not pass a budget gets a private full one, which is
 * the historical behaviour and stays right for every one-shot call. The
 * streaming path passes the completion's budget so its opens and its
 * reopens draw from one pot.
 */
async function runOpenAiWithRetry<T>(
  deps: OpenAiHttpDeps,
  path: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
  budget: OpenAiAttemptBudget = createOpenAiAttemptBudget(),
): Promise<T> {
  if (budget.remaining <= 0) {
    // Only reachable if a caller keeps using an exhausted budget. Fail
    // typed rather than falling through to a bare `Error("undefined")`.
    throw new OpenAiHttpError(
      `openai provider retry budget exhausted: ${deps.baseUrl}${path}`,
      null,
      `${deps.baseUrl}${path}`,
      false,
      null,
      deps.label,
    );
  }
  let lastError: unknown;
  while (budget.remaining > 0) {
    if (signal?.aborted) {
      throw new OpenAiHttpError(
        "completion aborted by caller",
        null,
        `${deps.baseUrl}${path}`,
      );
    }
    budget.remaining -= 1;
    // 1-based index of the request about to be made *within this
    // completion*, so the backoff keeps growing across a reopen instead
    // of resetting to the base delay every time the stream is retried.
    const attemptNumber = OPENAI_MAX_ATTEMPTS - budget.remaining;
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      // A caller-triggered abort is never retryable, whatever shape it
      // surfaced as.
      if (signal?.aborted) throw err;
      if (!isRetryableOpenAiError(err) || budget.remaining <= 0) throw err;
      await sleep(resolveWaitMs(err, attemptNumber), signal);
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

/**
 * Cooldown from structured error JSON, for providers that never send a
 * `retry-after` header. Gemini answers 429/503 with an
 * `error.details[]` entry of `@type google.rpc.RetryInfo` whose
 * `retryDelay` is a protobuf Duration string ("39s", "1.5s"). The
 * duration grammar admits only non-negative seconds, so anything else —
 * malformed, negative, non-string — is ignored and the caller keeps the
 * plain exponential backoff. The result flows through the same
 * `retryAfterMs` field as the header, so `resolveWaitMs` caps it at
 * `OPENAI_RETRY_AFTER_CAP_MS` exactly like a header-declared wait.
 */
function parseRetryInfoDelayMs(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const details = parsed.error.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isRecord(detail) || typeof detail.retryDelay !== "string") continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
    if (!match) continue;
    const ms = Math.round(Number(match[1]) * 1000);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
