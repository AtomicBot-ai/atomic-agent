import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { CompletionUsage } from "../llm/provider/completion-types.js";
import { spendDayKey } from "./daily-spend.js";
import type { CompletionPrice } from "./usage-meter.js";

/**
 * Tokens and spend per day, across every session (ATO-2352): the data
 * behind `atomic-agent usage`. `daily-spend.json` keeps only today's
 * dollars for the ceiling; this file keeps the history, split by day,
 * by model and by how the link bills (a local server, a subscription
 * plan, or a per-token cloud link).
 *
 * Durable and outside the model, in the state directory, so it survives
 * a restart and is shared by the terminal and the desktop app. Every
 * write re-reads the file first, like `DailySpendStore`, so two
 * processes add to one history. Only counts and model ids are stored:
 * no prompt, no reply, no path.
 *
 * Honesty rules match the session readout: only priced calls add to
 * `usd`; a cloud call with no known price is counted in
 * `unpricedCalls`, never as $0. Local and plan calls keep their tokens
 * and add no dollars.
 */
export type UsageBilling = "cloud" | "local" | "plan";

export interface UsageHistoryRow {
  billing: UsageBilling;
  providerId: string;
  /** The served model id, else the provider id when the service named none. */
  model: string;
  calls: number;
  /** Prompt tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (a subset of `inputTokens`). */
  cachedTokens: number;
  usd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

export interface UsageHistoryFile {
  version: 1;
  /** `YYYY-MM-DD` (the spend day, same reset hour as the daily ceiling) → rows. */
  days: Record<string, UsageHistoryRow[]>;
}

export interface UsageHistoryInput {
  providerId: string;
  modelId: string | null;
  /** The completion's tokens: the usage block, or a local server's timings. */
  usage: CompletionUsage;
  local: boolean;
  plan: boolean;
  price: CompletionPrice;
}

export const USAGE_HISTORY_FILE_NAME = "usage-history.json";
/** Days kept; older days are dropped on the next write. */
export const USAGE_HISTORY_MAX_DAYS = 400;

export interface UsageHistoryStoreOptions {
  path: string;
  /** UTC hour the day starts at (`llm.costTracking.dailyResetHourUtc`); read on every call. */
  resetHourUtc?: () => number;
  now?: () => number;
}

export class UsageHistoryStore {
  private readonly path: string;
  private readonly resetHourUtc: () => number;
  private readonly now: () => number;

  constructor(options: UsageHistoryStoreOptions) {
    this.path = options.path;
    this.resetHourUtc = options.resetHourUtc ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  /** The day key `record` would write to right now. */
  currentDay(): string {
    return spendDayKey(this.now(), this.resetHourUtc());
  }

  /** The whole history, read from disk (another process may have added to it). */
  read(): UsageHistoryFile {
    return readUsageHistory(this.path);
  }

  /** Fold one completion in. A completion with no tokens changes nothing. */
  record(input: UsageHistoryInput): void {
    const promptTokens = clean(input.usage.promptTokens);
    const output = clean(input.usage.completionTokens);
    if (promptTokens === 0 && output === 0) return;
    const file = this.read();
    const day = this.currentDay();
    const billing: UsageBilling = input.local ? "local" : input.plan ? "plan" : "cloud";
    const model = input.modelId ?? input.providerId;
    const rows = file.days[day] ?? [];
    const at = rows.findIndex(
      (r) => r.billing === billing && r.providerId === input.providerId && r.model === model,
    );
    const base: UsageHistoryRow = (at >= 0 ? rows[at] : undefined) ?? {
      billing,
      providerId: input.providerId,
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      usd: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
    };
    const priced = input.price.kind === "priced" ? input.price.usd : null;
    const next: UsageHistoryRow = {
      ...base,
      calls: base.calls + 1,
      inputTokens: base.inputTokens + promptTokens,
      outputTokens: base.outputTokens + output,
      cachedTokens: base.cachedTokens + clean(input.usage.cachedTokens),
      usd: base.usd + (priced ?? 0),
      pricedCalls: base.pricedCalls + (priced !== null ? 1 : 0),
      // A per-token cloud call without a price is the only "unknown cost".
      unpricedCalls: base.unpricedCalls + (billing === "cloud" && priced === null ? 1 : 0),
    };
    const nextRows = at >= 0 ? rows.map((r, i) => (i === at ? next : r)) : [...rows, next];
    this.write(prune({ version: 1, days: { ...file.days, [day]: nextRows } }));
  }

  private write(file: UsageHistoryFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // A read-only state dir must not fail a completion.
    }
  }
}

/** The history at `path`; a missing or damaged file reads as empty. */
export function readUsageHistory(path: string): UsageHistoryFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { version: 1, days: {} };
  }
  const days: Record<string, UsageHistoryRow[]> = {};
  const source = (raw as { days?: unknown } | null)?.days;
  if (source && typeof source === "object") {
    for (const [day, rows] of Object.entries(source as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(rows)) continue;
      const kept = rows.map(cleanRow).filter((r): r is UsageHistoryRow => r !== null);
      if (kept.length > 0) days[day] = kept;
    }
  }
  return { version: 1, days };
}

function cleanRow(value: unknown): UsageHistoryRow | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<UsageHistoryRow>;
  if (r.billing !== "cloud" && r.billing !== "local" && r.billing !== "plan") return null;
  if (typeof r.model !== "string" || typeof r.providerId !== "string") return null;
  return {
    billing: r.billing,
    providerId: r.providerId,
    model: r.model,
    calls: clean(r.calls),
    inputTokens: clean(r.inputTokens),
    outputTokens: clean(r.outputTokens),
    cachedTokens: clean(r.cachedTokens),
    usd: clean(r.usd),
    pricedCalls: clean(r.pricedCalls),
    unpricedCalls: clean(r.unpricedCalls),
  };
}

function prune(file: UsageHistoryFile): UsageHistoryFile {
  const keys = Object.keys(file.days).sort();
  if (keys.length <= USAGE_HISTORY_MAX_DAYS) return file;
  const keep = new Set(keys.slice(-USAGE_HISTORY_MAX_DAYS));
  return {
    version: 1,
    days: Object.fromEntries(Object.entries(file.days).filter(([day]) => keep.has(day))),
  };
}

function clean(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
