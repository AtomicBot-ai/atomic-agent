/**
 * What an HTTP error body says, read for its reason rather than its
 * status.
 *
 * Two shapes cover the OpenAI-compatible world:
 *
 *   OpenAI      `{ "error": { "message", "code", "type", "param" } }`
 *   OpenRouter  `{ "error": { "message", "code", "metadata": { "raw", "provider_name" } } }`
 *
 * where OpenRouter's `metadata.raw` is often the upstream vendor's own
 * body as a string — and that is where `credit_balance_exhausted`
 * actually appears. The status alone told the runtime nothing: a 429
 * for exhausted credit was parked and retried as rate limiting (42
 * times per worker, once), and a 402 carrying a "retry in 120 s" hint
 * ended a run as final.
 *
 * Pure: no imports, so the HTTP client can use it on the way out without
 * a cycle through the reliability layer.
 */
export interface ProviderErrorBody {
  /** `error.message`, when the body parsed. */
  readonly message?: string;
  /** `error.code` as a string (a numeric code is kept as its digits). */
  readonly code?: string;
  /** `error.type`. */
  readonly type?: string;
  /** Upstream vendor name from OpenRouter's `metadata.provider_name`. */
  readonly upstream?: string;
  /**
   * A cooldown the body's *text* asked for ("retry in 120 s", "try
   * again in 2 minutes"). Headers and structured `RetryInfo` are read
   * elsewhere; this is the fallback for providers that only say it.
   */
  readonly retryHintMs?: number;
  /** The whole body, bounded, for wording checks. */
  readonly text: string;
}

/** Longest body kept for wording checks. */
const BODY_TEXT_MAX = 2_000;

/**
 * Codes and types that mean the account cannot pay for the request.
 * `insufficient_quota` is OpenAI's own; the other two are OpenRouter's
 * and Anthropic-via-OpenRouter's.
 */
const CREDIT_CODES =
  /\b(?:credit_balance_exhausted|insufficient_credits|insufficient_quota)\b/i;

/** OpenRouter's "you have too many requests in flight for your balance". */
const IN_FLIGHT_BUDGET = /\bin_flight_budget_exhausted\b/i;

/** "retry in 120 s", "retry after 2 minutes", "try again in 30 seconds". */
const RETRY_HINT =
  /\b(?:retry|try again|please wait)(?:\s+\w+){0,2}?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;

export function parseProviderErrorBody(text: string): ProviderErrorBody {
  const bounded = text.slice(0, BODY_TEXT_MAX);
  const error = readErrorObject(bounded);
  const raw = error !== null ? readRaw(error.metadata) : null;
  const message = readString(error?.message);
  const code = readCode(error?.code);
  const type = readString(error?.type);
  const upstream = readString(readObject(error?.metadata)?.provider_name);
  const hint = retryHintMs(`${message ?? ""}\n${raw ?? ""}\n${bounded}`);
  return {
    ...(message !== undefined ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    ...(hint !== null ? { retryHintMs: hint } : {}),
    text: raw !== null && !bounded.includes(raw) ? `${bounded}\n${raw}` : bounded,
  };
}

/** What a body says about the account or a cooldown, before any status logic. */
export type ProviderErrorReason =
  | { kind: "credit_exhausted"; code: string }
  | { kind: "retry_after"; delayMs: number | null; code: string | null };

/**
 * Cooldown a provider is allowed to ask an interactive turn for. Longer
 * hints are clipped to this; a provider must not park a run.
 */
export const RETRY_HINT_MAX_MS = 180_000;

/** Wait for `in_flight_budget_exhausted` when the body names no delay. */
export const IN_FLIGHT_BUDGET_DEFAULT_WAIT_MS = 30_000;

/**
 * Read the reason out of a parsed body plus the transport facts around
 * it. `retryAfterMs` is the header / `RetryInfo` value the HTTP client
 * already extracted, when any.
 */
export function readProviderErrorReason(input: {
  status: number | null;
  body: ProviderErrorBody | undefined;
  /** The error's own message: the body's head when `body` is absent. */
  message: string;
  retryAfterMs: number | null;
}): ProviderErrorReason | null {
  const { status } = input;
  const code = input.body?.code ?? input.body?.type ?? "";
  const text = `${code}\n${input.body?.text ?? ""}\n${input.message}`;
  const credit = CREDIT_CODES.exec(text);
  if (credit !== null) {
    return { kind: "credit_exhausted", code: credit[0].toLowerCase() };
  }
  if (status === 402 && /\bcredits?\b/i.test(text)) {
    return { kind: "credit_exhausted", code: "402" };
  }
  if (!isCooldownStatus(status)) return null;
  const hinted = input.retryAfterMs ?? input.body?.retryHintMs ?? null;
  if (IN_FLIGHT_BUDGET.test(text)) {
    return {
      kind: "retry_after",
      delayMs: hinted ?? IN_FLIGHT_BUDGET_DEFAULT_WAIT_MS,
      code: "in_flight_budget_exhausted",
    };
  }
  if (hinted !== null) {
    return { kind: "retry_after", delayMs: hinted, code: code || null };
  }
  return null;
}

/** Statuses whose body may legitimately ask for a cooldown. */
function isCooldownStatus(status: number | null): boolean {
  return status === 402 || status === 408 || status === 429 || (status !== null && status >= 500);
}

function retryHintMs(text: string): number | null {
  const match = RETRY_HINT.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = match[2]!.toLowerCase();
  const ms = unit.startsWith("ms") || unit.startsWith("milli")
    ? amount
    : unit.startsWith("m")
      ? amount * 60_000
      : amount * 1_000;
  return Math.round(ms);
}

function readErrorObject(text: string): Record<string, unknown> | null {
  const parsed = tryParseJson(text);
  const error = readObject(parsed?.error);
  return error;
}

/** OpenRouter's `metadata.raw`: the upstream body, as text or as an object. */
function readRaw(metadata: unknown): string | null {
  const raw = readObject(metadata)?.raw;
  if (typeof raw === "string") return raw.slice(0, BODY_TEXT_MAX);
  if (raw !== null && typeof raw === "object") {
    try {
      return JSON.stringify(raw).slice(0, BODY_TEXT_MAX);
    } catch {
      return null;
    }
  }
  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return readObject(JSON.parse(text.slice(start)));
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCode(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
