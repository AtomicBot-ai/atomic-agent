/**
 * Rate-limit state a provider reported alongside a completion (ATO-569).
 *
 * Two kinds, kept apart because they answer different questions:
 *
 *  - `subscription`: how much of a plan window is used — the ChatGPT
 *    login behind Codex (`x-codex-primary-*` / `rate_limits` events) and
 *    a Claude subscription (`anthropic-ratelimit-unified-*` headers, or
 *    the Claude Code CLI's `rate_limit_event`). The figure people ask
 *    for: "how much is left, and when does it reset".
 *  - `api`: an API key's per-minute request / token budget
 *    (`x-ratelimit-*` on OpenAI, OpenRouter and most compatible hosts,
 *    `anthropic-ratelimit-requests-*` on Anthropic's own API).
 *
 * Every parser here is total: an absent, partial or malformed header or
 * payload yields fewer windows, never a throw, and never a guessed
 * number. A window with no figure the user could act on (no percent, no
 * remaining count, no reset time, no status) is dropped.
 */
export interface RateLimitWindow {
  scope: "subscription" | "api";
  /**
   * Short window name as shown to the user: `5h`, `weekly`, `requests`,
   * `tokens`. Stable per source, so a fresh reading replaces the old one.
   */
  name: string;
  /** Share of the window used, 0–100. */
  usedPercent?: number;
  /** Units left in the window (requests or tokens), for `api` windows. */
  remaining?: number;
  /** Size of the window in the same units as `remaining`. */
  limit?: number;
  /** When the window resets, epoch milliseconds. */
  resetsAt?: number;
  /**
   * The provider's own verdict where it gives one (`allowed`,
   * `allowed_warning`, `rejected`). Kept verbatim.
   */
  status?: string;
}

/** Anything with a `get(name)` — a fetch `Headers`, or a test's map. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Every rate-limit window a response's headers describe. */
export function parseRateLimitHeaders(
  headers: HeaderReader,
  now: number = Date.now(),
): RateLimitWindow[] {
  return [
    ...parseCodexHeaders(headers, now),
    ...parseAnthropicUnifiedHeaders(headers),
    ...parseAnthropicApiHeaders(headers),
    ...parseOpenAiStyleHeaders(headers, now),
  ];
}

/**
 * The ChatGPT backend Codex talks to: `x-codex-primary-used-percent`,
 * `-window-minutes`, `-reset-after-seconds` (older) or `-reset-at`
 * (epoch seconds), and the same for `secondary`. Primary is the short
 * window (5h), secondary the long one (weekly); the window length, when
 * sent, names it.
 */
function parseCodexHeaders(h: HeaderReader, now: number): RateLimitWindow[] {
  const out: RateLimitWindow[] = [];
  for (const which of ["primary", "secondary"] as const) {
    const used = num(h.get(`x-codex-${which}-used-percent`));
    const minutes = num(h.get(`x-codex-${which}-window-minutes`));
    const resetAt = num(h.get(`x-codex-${which}-reset-at`));
    const resetAfter = num(h.get(`x-codex-${which}-reset-after-seconds`));
    const resetsAt =
      resetAt !== undefined
        ? epochToMs(resetAt)
        : resetAfter !== undefined
          ? now + resetAfter * 1000
          : undefined;
    const window = compact({
      scope: "subscription",
      name: windowName(minutes, which),
      usedPercent: percent(used),
      resetsAt,
    });
    if (window) out.push(window);
  }
  return out;
}

/**
 * A Claude subscription seen over HTTP (an OAuth-backed request):
 * `anthropic-ratelimit-unified-5h-utilization` (0–1) and `-5h-reset`
 * (epoch seconds), the same for `7d`, plus an overall `-status`.
 */
function parseAnthropicUnifiedHeaders(h: HeaderReader): RateLimitWindow[] {
  const out: RateLimitWindow[] = [];
  const status = h.get("anthropic-ratelimit-unified-status") ?? undefined;
  for (const [key, name] of [
    ["5h", "5h"],
    ["7d", "weekly"],
    ["7d_opus", "weekly opus"],
  ] as const) {
    const utilization = num(h.get(`anthropic-ratelimit-unified-${key}-utilization`));
    const reset = num(h.get(`anthropic-ratelimit-unified-${key}-reset`));
    const window = compact({
      scope: "subscription",
      name,
      usedPercent: utilization === undefined ? undefined : percent(fractionToPercent(utilization)),
      resetsAt: reset === undefined ? undefined : epochToMs(reset),
    });
    if (window) out.push(window);
  }
  if (out.length === 0 && status) {
    const reset = num(h.get("anthropic-ratelimit-unified-reset"));
    const window = compact({
      scope: "subscription",
      name: "plan",
      status,
      resetsAt: reset === undefined ? undefined : epochToMs(reset),
    });
    if (window) out.push(window);
  } else if (status) {
    for (const w of out) w.status = status;
  }
  return out;
}

/** Anthropic's own API: `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}` (RFC 3339 reset). */
function parseAnthropicApiHeaders(h: HeaderReader): RateLimitWindow[] {
  const out: RateLimitWindow[] = [];
  for (const kind of ["requests", "tokens", "input-tokens", "output-tokens"] as const) {
    const limit = num(h.get(`anthropic-ratelimit-${kind}-limit`));
    const remaining = num(h.get(`anthropic-ratelimit-${kind}-remaining`));
    const reset = h.get(`anthropic-ratelimit-${kind}-reset`);
    const resetsAt = reset ? Date.parse(reset) : NaN;
    const window = compact({
      scope: "api",
      name: kind.replace("-", " "),
      limit,
      remaining,
      usedPercent: usedFrom(limit, remaining),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    });
    if (window) out.push(window);
  }
  return out;
}

/**
 * OpenAI and the hosts that copy it: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 * with a duration reset (`1s`, `6m0s`, `20ms`). OpenRouter and a few
 * others send the unsuffixed `x-ratelimit-limit / -remaining / -reset`,
 * where the reset is an epoch (ms or s).
 */
function parseOpenAiStyleHeaders(h: HeaderReader, now: number): RateLimitWindow[] {
  const out: RateLimitWindow[] = [];
  for (const kind of ["requests", "tokens"] as const) {
    const limit = num(h.get(`x-ratelimit-limit-${kind}`));
    const remaining = num(h.get(`x-ratelimit-remaining-${kind}`));
    const resetIn = parseDurationMs(h.get(`x-ratelimit-reset-${kind}`));
    const window = compact({
      scope: "api",
      name: kind,
      limit,
      remaining,
      usedPercent: usedFrom(limit, remaining),
      resetsAt: resetIn === undefined ? undefined : now + resetIn,
    });
    if (window) out.push(window);
  }
  if (out.length > 0) return out;
  const limit = num(h.get("x-ratelimit-limit"));
  const remaining = num(h.get("x-ratelimit-remaining"));
  const resetRaw = h.get("x-ratelimit-reset");
  const resetNum = num(resetRaw);
  // An epoch (s or ms) on OpenRouter; a few hosts send seconds-from-now.
  const resetsAt =
    resetNum !== undefined
      ? resetNum < 1e9
        ? now + resetNum * 1000
        : epochToMs(resetNum)
      : (() => {
          const d = parseDurationMs(resetRaw);
          return d === undefined ? undefined : now + d;
        })();
  const window = compact({
    scope: "api",
    name: "requests",
    limit,
    remaining,
    usedPercent: usedFrom(limit, remaining),
    resetsAt,
  });
  if (window) out.push(window);
  return out;
}

/**
 * The `rate_limits` object Codex puts on its token-count events:
 * `{ primary: { used_percent, window_minutes, resets_in_seconds | resets_at }, secondary: {…} }`.
 * Accepts `unknown` because the payload comes straight out of a CLI's
 * NDJSON, whose shape we do not control.
 */
export function parseCodexRateLimitsPayload(
  payload: unknown,
  now: number = Date.now(),
): RateLimitWindow[] {
  if (!isRecord(payload)) return [];
  const out: RateLimitWindow[] = [];
  for (const which of ["primary", "secondary"] as const) {
    const w = payload[which];
    if (!isRecord(w)) continue;
    const used = numValue(w.used_percent);
    const minutes = numValue(w.window_minutes);
    const resetsAtRaw = numValue(w.resets_at);
    const resetsIn = numValue(w.resets_in_seconds);
    const window = compact({
      scope: "subscription",
      name: windowName(minutes, which),
      usedPercent: percent(used),
      resetsAt:
        resetsAtRaw !== undefined
          ? epochToMs(resetsAtRaw)
          : resetsIn !== undefined
            ? now + resetsIn * 1000
            : undefined,
    });
    if (window) out.push(window);
  }
  return out;
}

/**
 * The Claude Code CLI's `rate_limit_event.rate_limit_info`:
 * `{ status, resetsAt (epoch s), rateLimitType: "five_hour" | "seven_day" | …, utilization? (0–1) }`.
 * The CLI does not always send a utilization figure; then only the
 * status and the reset time are known, and nothing is made up.
 */
export function parseClaudeRateLimitInfo(info: unknown): RateLimitWindow[] {
  if (!isRecord(info)) return [];
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  const name =
    type === "five_hour"
      ? "5h"
      : type === "seven_day"
        ? "weekly"
        : type === "seven_day_opus"
          ? "weekly opus"
          : type.length > 0
            ? type.replace(/_/g, " ")
            : "plan";
  const utilization = numValue(info.utilization);
  const resetsAt = numValue(info.resetsAt);
  const window = compact({
    scope: "subscription",
    name,
    usedPercent:
      utilization === undefined ? undefined : percent(fractionToPercent(utilization)),
    resetsAt: resetsAt === undefined ? undefined : epochToMs(resetsAt),
    status: typeof info.status === "string" ? info.status : undefined,
  });
  return window ? [window] : [];
}

function windowName(minutes: number | undefined, which: "primary" | "secondary"): string {
  if (minutes !== undefined && minutes > 0) {
    if (minutes >= 7 * 24 * 60 - 60 && minutes <= 7 * 24 * 60 + 60) return "weekly";
    if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return which === "primary" ? "5h" : "weekly";
}

/** Drop undefined fields; drop the whole window when it says nothing. */
function compact(w: {
  scope: RateLimitWindow["scope"];
  name: string;
  usedPercent?: number | undefined;
  remaining?: number | undefined;
  limit?: number | undefined;
  resetsAt?: number | undefined;
  status?: string | undefined;
}): RateLimitWindow | null {
  const out: RateLimitWindow = { scope: w.scope, name: w.name };
  if (w.usedPercent !== undefined) out.usedPercent = w.usedPercent;
  if (w.remaining !== undefined) out.remaining = w.remaining;
  if (w.limit !== undefined) out.limit = w.limit;
  if (w.resetsAt !== undefined && Number.isFinite(w.resetsAt)) out.resetsAt = w.resetsAt;
  if (w.status !== undefined && w.status.length > 0) out.status = w.status;
  // A bare `allowed` with no figure says nothing anyone can act on.
  const informative =
    out.usedPercent !== undefined ||
    out.remaining !== undefined ||
    (out.status !== undefined && out.status !== "allowed");
  return informative ? out : null;
}

function usedFrom(limit: number | undefined, remaining: number | undefined): number | undefined {
  if (limit === undefined || remaining === undefined || limit <= 0) return undefined;
  return percent(((limit - remaining) / limit) * 100);
}

function percent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  // Two decimals: 0.91 × 100 is 91.00000000000001 in floating point.
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/** Anthropic sends utilization as a 0–1 fraction. */
function fractionToPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

/** An epoch in seconds or milliseconds, to milliseconds. */
function epochToMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

function num(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function numValue(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") return num(raw);
  return undefined;
}

/**
 * OpenAI's reset durations: `1s`, `6m0s`, `1h2m3s`, `20ms`, `0.5s`.
 * A bare number is read as seconds.
 */
export function parseDurationMs(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  const bare = num(text);
  if (bare !== undefined) return bare * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = "";
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const value = Number(m[1]);
    const unit = m[2];
    total += unit === "h" ? value * 3_600_000 : unit === "m" ? value * 60_000 : unit === "s" ? value * 1000 : value;
    matched += m[0];
  }
  return matched.length === text.length ? total : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
