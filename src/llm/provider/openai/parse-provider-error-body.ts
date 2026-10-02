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
  /** `error.message`, when the body parsed; a top-level `message` when it has no `error` object. */
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

/**
 * An empty account in a provider's words, for the bodies that carry no
 * code for it: AI/ML API's 403 "You've run out of funds", DeepSeek's 402
 * "Insufficient Balance", Moonshot's 429 "suspended due to insufficient
 * balance, please recharge your account", "Your credit balance is too
 * low", "Payment Required".
 *
 * Deliberately not "quota" or "billing" on their own: a per-minute rate
 * limit says "You exceeded your current quota, please check your plan and
 * billing details" too (Gemini's free tier, a 429 with a cooldown), and
 * must keep its wait.
 */
const NO_FUNDS_WORDING =
  /\b(?:out of (?:funds|credits?|balance|money)|insufficient[ _-]?(?:funds|balance|credits?|account[ _-]balance)|not enough (?:funds|credits?|balance|money)|(?:credit|account|wallet) balance (?:is )?(?:too low|exhausted|insufficient|empty|depleted)|(?:no|zero) (?:credits?|funds|balance) (?:left|remaining)|payment[ _-]required|top[ -]?up (?:your |the )?(?:balance|account|credits?|wallet)|recharge (?:your |the )?(?:account|balance|wallet))\b/i;

/**
 * Billing words a 402 or a 403 is read for (never a 429, see above):
 * "billing is not enabled", "update your payment method".
 */
const BILLING_WORDING =
  /\b(?:billing|payment[ _-]?method|payment details|add (?:a )?payment)\b/i;

/** Words about the key itself: a 403 that has them is not read for `BILLING_WORDING`. */
const KEY_WORDS =
  /\b(?:api[ _-]?key|credentials?|unauthori[sz]ed|unauthenticated|access[ _-]?token)\b/i;

/** "retry in 120 s", "retry after 2 minutes", "try again in 30 seconds". */
const RETRY_HINT =
  /\b(?:retry|try again|please wait)(?:\s+\w+){0,2}?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;

export function parseProviderErrorBody(text: string): ProviderErrorBody {
  const bounded = text.slice(0, BODY_TEXT_MAX);
  const root = tryParseJson(bounded);
  const error = readObject(root?.error);
  const raw = error !== null ? readRaw(error.metadata) : null;
  // A body with no `error` object says it at the top: AI/ML API answers
  // `{"title": "Forbidden", "status": 403, "message": "You've run out of
  // funds. …"}`, and that sentence is the one worth quoting.
  const message =
    readString(error?.message) ??
    (error === null ? readString(root?.message) : undefined);
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
 *
 * `credit_exhausted` is every billing refusal: a code that says so, a
 * 402 that asked for no cooldown, and a 403 or 429 whose words say the
 * account cannot pay (`NO_FUNDS_WORDING`; a 403 also `BILLING_WORDING`).
 * A 429 counts only when it asked for no cooldown either: a rate limit
 * that names one stays a wait. Item 40: AI/ML API's 403 "You've run out
 * of funds" read as nothing at all, so its fallback chain parked the turn
 * on a stopped local server and the window named that server.
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
  const hinted = input.retryAfterMs ?? input.body?.retryHintMs ?? null;
  const inFlight = IN_FLIGHT_BUDGET.test(text);
  if (!inFlight && saysAccountCannotPay(status, text, hinted)) {
    return { kind: "credit_exhausted", code: String(status) };
  }
  if (!isCooldownStatus(status)) return null;
  if (inFlight) {
    return {
      kind: "retry_after",
      delayMs: hinted ?? IN_FLIGHT_BUDGET_DEFAULT_WAIT_MS,
      code: "in_flight_budget_exhausted",
    };
  }
  if (hinted !== null) {
    return { kind: "retry_after", delayMs: hinted, code: code || null };
  }
  // Payment Required that asked for no cooldown: the account's answer,
  // whatever its words.
  if (status === 402) return { kind: "credit_exhausted", code: "402" };
  return null;
}

/** A 402, 403 or 429 whose words say the account cannot pay. */
function saysAccountCannotPay(
  status: number | null,
  text: string,
  hinted: number | null,
): boolean {
  if (status === 402 || status === 403) {
    if (NO_FUNDS_WORDING.test(text)) return true;
    return (
      BILLING_WORDING.test(text) && (status === 402 || !KEY_WORDS.test(text))
    );
  }
  if (status === 429) return hinted === null && NO_FUNDS_WORDING.test(text);
  return false;
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
