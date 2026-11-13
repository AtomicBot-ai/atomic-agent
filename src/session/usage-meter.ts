import type { CompletionUsage } from "../llm/provider/completion-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import type { RateLimitWindow } from "../llm/provider/rate-limits.js";
import { estimateUsageCostUsd } from "../llm/provider/usage-cost.js";
import type { DailySpendView } from "./daily-spend.js";

/**
 * What a session has spent and how much of the account's limits is left
 * (ATO-569) — the second half of the composer readout beside the
 * context gauge: `ctx 42% · $0.31 · 17% left, resets 15:00`.
 *
 * Lives in the session module for the same reason `context-usage.ts`
 * does: the figures belong to the session, not to the screen. The
 * runtime folds every completion into a {@link SessionUsageLedger},
 * `executeTurn` stamps the result onto `SessionState.sessionUsage` so a
 * reopened session shows its spend at once, and the `usage_updated`
 * loop event carries it live to the TUI and the HTTP stream.
 *
 * Honesty rules, each with a test:
 *  - A cloud call with no known price is counted as *unpriced*, never as
 *    $0. A session with only unpriced calls shows "cost n/a"; a session
 *    with some priced and some unpriced shows the priced sum with a `+`.
 *  - A call served by a local model is counted as *local* and shown as
 *    "local", not "$0.00": nothing was billed, and nothing is pretended.
 *  - A rate-limit reading is dropped once its reset time has passed. A
 *    reading with no reset time is kept for {@link STALE_READING_MS}.
 */
export interface SessionUsageState {
  /** Sum of every priced call's cost, USD. */
  costUsd: number;
  pricedCalls: number;
  /** Cloud calls whose model had no price from any source. */
  unpricedCalls: number;
  /** Calls served by a local model (never billed). */
  localCalls: number;
  /**
   * Calls served through a subscription CLI (Claude Code, Codex): billed
   * by the plan, not per token, so they add nothing to `costUsd`.
   */
  planCalls: number;
  /** Where the priced calls' prices came from, distinct, first-seen order. */
  costSources: readonly CostSource[];
  /** Up to {@link MAX_UNPRICED_MODELS} model ids that had no price. */
  unpricedModels: readonly string[];
  /** The account rate-limit readings in force when this was recorded. */
  limits: readonly LimitReading[];
  updatedAt: number;
  /**
   * What every session spent today, and the daily ceiling if one is set
   * (ATO-649). Stamped on the live `usage_updated` event only, when the
   * operator asked to see it (`costTracking.showInStatusBar`) or set a
   * ceiling (`costTracking.dailyLimitUsd`); never part of what a session
   * persists, because the day is not the session's.
   */
  today?: DailySpendView;
}

/**
 * Price priority, best first: what the service billed (`usage.costUsd`),
 * a price the operator configured (`userModels[].pricing`), the bundled
 * catalog, the provider's live model list. Nothing else is guessed.
 */
export type CostSource = "provider" | "user" | "catalog" | "live";

export interface LimitReading extends RateLimitWindow {
  /** The provider link (account) the reading came from. */
  providerId: string;
  modelId: string | null;
  observedAt: number;
}

export const EMPTY_SESSION_USAGE: SessionUsageState = {
  costUsd: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  localCalls: 0,
  planCalls: 0,
  costSources: [],
  unpricedModels: [],
  limits: [],
  updatedAt: 0,
};

/** How long a reading without a reset time is trusted. */
export const STALE_READING_MS = 60 * 60 * 1000;
export const MAX_UNPRICED_MODELS = 5;

/** One completion, as the runtime's provider seam sees it. */
export interface UsageRecordInput {
  providerId: string;
  modelId: string | null;
  usage?: CompletionUsage;
  /** The resolved model with its pricing, when any source priced it. */
  model?: Pick<ResolvedModel, "pricing" | "source">;
  /** The serving link is a local model server. */
  local: boolean;
  /** The serving link is a subscription CLI (plan-billed). */
  plan?: boolean;
  rateLimits?: readonly RateLimitWindow[];
}

export type CompletionPrice =
  | { kind: "priced"; usd: number; source: CostSource }
  | { kind: "local" }
  | { kind: "plan" }
  | { kind: "unpriced" }
  | { kind: "none" };

/**
 * The cost of one completion under the priority above. `none` means the
 * call reported no usage at all, so there is nothing to count.
 */
export function priceCompletion(
  input: Pick<UsageRecordInput, "usage" | "model" | "local" | "plan">,
): CompletionPrice {
  if (input.local) return { kind: "local" };
  const usage = input.usage;
  if (!usage) return { kind: "none" };
  if (input.plan) return { kind: "plan" };
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return { kind: "priced", usd: usage.costUsd, source: "provider" };
  }
  const pricing = input.model?.pricing;
  if (!pricing) return { kind: "unpriced" };
  const source = input.model?.source;
  return {
    kind: "priced",
    usd: estimateUsageCostUsd(usage, pricing),
    source: source === "user" ? "user" : source === "live" ? "live" : "catalog",
  };
}

/** Fold one completion into a session's usage. Pure. */
export function recordCompletionUsage(
  state: SessionUsageState | undefined,
  input: UsageRecordInput,
  limits: readonly LimitReading[],
  now: number,
): SessionUsageState {
  const base = state ?? EMPTY_SESSION_USAGE;
  const price = priceCompletion(input);
  let next: SessionUsageState = { ...base, limits, updatedAt: now };
  if (price.kind === "priced") {
    next = {
      ...next,
      costUsd: base.costUsd + price.usd,
      pricedCalls: base.pricedCalls + 1,
      costSources: base.costSources.includes(price.source)
        ? base.costSources
        : [...base.costSources, price.source],
    };
  } else if (price.kind === "local") {
    next = { ...next, localCalls: base.localCalls + 1 };
  } else if (price.kind === "plan") {
    next = { ...next, planCalls: (base.planCalls ?? 0) + 1 };
  } else if (price.kind === "unpriced") {
    const id = input.modelId ?? input.providerId;
    next = {
      ...next,
      unpricedCalls: base.unpricedCalls + 1,
      unpricedModels:
        base.unpricedModels.includes(id) || base.unpricedModels.length >= MAX_UNPRICED_MODELS
          ? base.unpricedModels
          : [...base.unpricedModels, id],
    };
  }
  return next;
}

/** The readings still in force at `now`: past their reset, or stale, they are gone. */
export function activeLimits(
  limits: readonly LimitReading[],
  now: number,
): LimitReading[] {
  return limits.filter((r) =>
    r.resetsAt !== undefined ? r.resetsAt > now : now - r.observedAt < STALE_READING_MS,
  );
}

/**
 * Per-session usage for the life of the process, plus the account-wide
 * rate-limit readings every session shares (a limit belongs to the
 * account behind a provider link, not to one thread).
 */
export class SessionUsageLedger {
  private readonly sessions = new Map<string, SessionUsageState>();
  private readonly readings = new Map<string, LimitReading>();
  /** Fusion worker session id → the session whose turn spawned it (ATO-1388). */
  private readonly forwards = new Map<string, string>();
  private readonly onChange: ((sessionId: string, state: SessionUsageState) => void) | undefined;
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: {
    onChange?: (sessionId: string, state: SessionUsageState) => void;
    now?: () => number;
    maxSessions?: number;
  } = {}) {
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 500;
  }

  /**
   * Start a session from what it persisted, so a reopened thread keeps
   * adding to its own total. Ignored once the ledger already tracks it.
   */
  seed(sessionId: string, state: SessionUsageState | undefined): void {
    if (!state || this.sessions.has(sessionId)) return;
    this.remember(sessionId, state);
  }

  /**
   * Count a fusion worker's calls on the session that spawned it
   * (ATO-1388). A worker runs in a throwaway session nobody sees and
   * nothing saves, so its spend recorded there never reached the
   * composer readout: the person saw less than they spent. Once linked,
   * every call recorded under `workerSessionId` lands on
   * `parentSessionId` with the same pricing rules (unpriced stays
   * unpriced, local stays local). Kept bounded like the sessions map.
   */
  forward(workerSessionId: string, parentSessionId: string): void {
    if (workerSessionId === parentSessionId) return;
    this.forwards.delete(workerSessionId);
    this.forwards.set(workerSessionId, parentSessionId);
    if (this.forwards.size > this.maxSessions) {
      const oldest = this.forwards.keys().next().value;
      if (oldest !== undefined) this.forwards.delete(oldest);
    }
  }

  record(sessionId: string, input: UsageRecordInput): SessionUsageState {
    sessionId = this.forwards.get(sessionId) ?? sessionId;
    const now = this.now();
    for (const w of input.rateLimits ?? []) {
      this.readings.set(`${input.providerId}/${w.scope}/${w.name}`, {
        ...w,
        providerId: input.providerId,
        modelId: input.modelId,
        observedAt: now,
      });
    }
    for (const [key, r] of this.readings) {
      if (activeLimits([r], now).length === 0) this.readings.delete(key);
    }
    const next = recordCompletionUsage(
      this.sessions.get(sessionId),
      input,
      [...this.readings.values()],
      now,
    );
    this.remember(sessionId, next);
    this.onChange?.(sessionId, next);
    return next;
  }

  get(sessionId: string): SessionUsageState | undefined {
    return this.sessions.get(sessionId);
  }

  private remember(sessionId: string, state: SessionUsageState): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    if (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
  }
}

/**
 * Wrap the runtime's worker-session factory so every worker it mints
 * counts its calls on the session that spawned it (ATO-1388).
 */
export function forwardWorkerUsage<
  M extends { parentSessionId: string },
  S extends { id: string },
  D = string | undefined,
>(
  create: (meta: M, dir?: D) => S,
  ledger: Pick<SessionUsageLedger, "forward">,
): (meta: M, dir?: D) => S {
  return (meta, dir) => {
    const worker = create(meta, dir);
    ledger.forward(worker.id, meta.parentSessionId);
    return worker;
  };
}

/* ---------------- formatting ---------------- */

/**
 * The cost part of the readout, or `null` when the session has made no
 * call worth mentioning yet. `$0.31`, `$0.31+` (some calls unpriced),
 * `cost n/a` (every cloud call unpriced), `plan` (subscription calls
 * only), `local` (local calls only).
 */
export function formatSessionCost(state: SessionUsageState | undefined): string | null {
  if (!state) return null;
  if (state.pricedCalls > 0) {
    return `${formatUsd(state.costUsd)}${state.unpricedCalls > 0 ? "+" : ""}`;
  }
  if (state.unpricedCalls > 0) return "cost n/a";
  if ((state.planCalls ?? 0) > 0) return "plan";
  if (state.localCalls > 0) return "local";
  return null;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/**
 * The one reading worth a place in the status line: the subscription
 * window closest to its end, else an API window that is at least
 * {@link API_LIMIT_SHOWN_FROM} used (a per-minute request budget that is
 * 3% used is noise). `null` when nothing qualifies.
 */
export function pickHeadlineLimit(
  limits: readonly LimitReading[],
  now: number,
): LimitReading | null {
  const live = activeLimits(limits, now);
  const rank = (r: LimitReading): number =>
    r.status === "rejected" ? 101 : r.usedPercent ?? (r.status === "allowed_warning" ? 90 : -1);
  const subs = live.filter((r) => r.scope === "subscription" && rank(r) >= 0);
  if (subs.length > 0) return subs.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const apis = live.filter(
    (r) => r.scope === "api" && (r.status === "rejected" || (r.usedPercent ?? 0) >= API_LIMIT_SHOWN_FROM),
  );
  if (apis.length > 0) return apis.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return null;
}

export const API_LIMIT_SHOWN_FROM = 80;

/** `17% left, resets 15:00`, `limit reached, resets Mon 09:00`, `near limit`. */
export function formatLimit(r: LimitReading, now: number): string {
  const reset = r.resetsAt !== undefined ? `, resets ${formatResetTime(r.resetsAt, now)}` : "";
  if (r.status === "rejected" || (r.usedPercent !== undefined && r.usedPercent >= 100)) {
    return `limit reached${reset}`;
  }
  if (r.usedPercent !== undefined) {
    return `${Math.max(0, Math.round(100 - r.usedPercent))}% left${reset}`;
  }
  if (r.remaining !== undefined) return `${r.remaining} left${reset}`;
  if (r.status === "allowed_warning") return `near limit${reset}`;
  return `${r.status ?? "limit"}${reset}`;
}

/** `15:00` today, `Mon 15:00` within a week, else `12 Nov`. Local time. */
export function formatResetTime(at: number, now: number): string {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hhmm;
  if (at - now < 6 * 24 * 60 * 60 * 1000) {
    return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hhmm}`;
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Today's part of the readout (ATO-649): `today $1.20`, `today $1.20+`
 * (some calls unpriced), `today $1.20 of $5.00` with a ceiling set.
 * `null` when there is no reading or nothing was priced today: an
 * unknown price shows nothing rather than a made-up `$0.00`. With a
 * ceiling and nothing priced yet, `today $0.00 of $5.00` is true and
 * worth saying.
 */
export function formatDailySpend(today: DailySpendView | undefined): string | null {
  if (!today) return null;
  const limit = today.limitUsd !== undefined && today.limitUsd > 0 ? today.limitUsd : null;
  if (today.pricedCalls === 0 && limit === null) return null;
  const spent = `${formatUsd(today.usd)}${today.unpricedCalls > 0 ? "+" : ""}`;
  return limit === null ? `today ${spent}` : `today ${spent} of ${formatUsd(limit)}`;
}

/**
 * The status-line parts this module owns, in order: session cost,
 * today's spend, then limit. Only parts with data; an empty array draws
 * nothing.
 */
export function usageStatusParts(
  state: SessionUsageState | undefined,
  now: number,
): string[] {
  const parts: string[] = [];
  const cost = formatSessionCost(state);
  if (cost) parts.push(cost);
  const today = formatDailySpend(state?.today);
  if (today) parts.push(today);
  const limit = state ? pickHeadlineLimit(state.limits, now) : null;
  if (limit) parts.push(formatLimit(limit, now));
  return parts;
}

/** The `/usage` breakdown: every figure the readout is made of. */
export function formatUsageReport(
  state: SessionUsageState | undefined,
  now: number,
): string {
  const lines: string[] = ["Session usage"];
  if (!state || state.pricedCalls + state.unpricedCalls + state.localCalls + (state.planCalls ?? 0) === 0) {
    lines.push("  cost: nothing recorded yet in this session");
  } else {
    if (state.pricedCalls > 0) {
      lines.push(
        `  cost: ${formatUsd(state.costUsd)} over ${plural(state.pricedCalls, "priced call")}` +
          ` (prices from ${state.costSources.map(sourceLabel).join(", ")})`,
      );
    }
    if (state.unpricedCalls > 0) {
      lines.push(
        `  ${plural(state.unpricedCalls, "call")} with no known price` +
          (state.unpricedModels.length > 0 ? ` (${state.unpricedModels.join(", ")})` : "") +
          " — not counted. Set llm.userModels[].pricing to count them.",
      );
    }
    if ((state.planCalls ?? 0) > 0) {
      lines.push(`  ${plural(state.planCalls, "call")} through a subscription — billed by the plan, not per token`);
    }
    if (state.localCalls > 0) {
      lines.push(`  ${plural(state.localCalls, "call")} on a local model — not billed`);
    }
  }
  const today = formatDailySpend(state?.today);
  if (today) {
    lines.push(
      `  ${today}, all sessions` +
        (state?.today?.limitUsd !== undefined
          ? " (paid calls stop at the limit: llm.costTracking.dailyLimitUsd)"
          : ""),
    );
  }
  const live = activeLimits(state?.limits ?? [], now);
  if (live.length === 0) {
    lines.push(
      "  limits: no reading yet. API keys report them in response headers;",
      "  a Claude subscription reports them only while streaming through the claude CLI,",
      "  and codex exec does not report them, so a ChatGPT subscription may show none.",
    );
  } else {
    lines.push("  limits:");
    for (const r of live) {
      const scope = r.scope === "subscription" ? "plan" : "api";
      const count =
        r.remaining !== undefined && r.limit !== undefined ? ` (${r.remaining} of ${r.limit} left)` : "";
      lines.push(`    ${r.providerId} ${scope} ${r.name}: ${formatLimit(r, now)}${count}`);
    }
  }
  return lines.join("\n");
}

function sourceLabel(source: CostSource): string {
  switch (source) {
    case "provider":
      return "the provider's bill";
    case "user":
      return "your configured prices";
    case "catalog":
      return "the built-in price list";
    case "live":
      return "the provider's live price list";
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
