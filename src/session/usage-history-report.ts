import { formatUsd } from "./usage-meter.js";
import type { UsageBilling, UsageCounts, UsageHistoryFile } from "./usage-history-types.js";

/**
 * The per-day view of `usage-history.json` (ATO-2352), for
 * `atomic-agent usage`: one line per day with input, output and cached
 * tokens, how many of the tokens a local model served, and the priced
 * cloud cost. Precedent: `ccusage daily` and Claude Code's `/usage`.
 */
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Input + output tokens served by a local model. */
  localTokens: number;
  /** Input + output tokens served by a per-token cloud link. */
  cloudTokens: number;
  /** Input + output tokens served through a subscription plan. */
  planTokens: number;
  usd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

export interface UsageModelLine extends UsageTotals {
  billing: UsageBilling;
  providerId: string;
  model: string;
}

export interface UsageDayLine extends UsageTotals {
  day: string;
  models: UsageModelLine[];
  /** Sessions that made a model call that day; `null` for a day recorded before sessions were counted (ATO-2442). */
  sessions: number | null;
}

export interface UsageHistorySummary {
  /** First day of the window, `null` for `--all`. */
  from: string | null;
  to: string;
  days: UsageDayLine[];
  total: UsageTotals;
  /** Distinct sessions over the window; `null` when no day in it counted sessions. */
  sessions: number | null;
}

/**
 * Days `today` and the `days - 1` before it (or every stored day for
 * `"all"`), newest last, only days that recorded something.
 */
export function summarizeUsageHistory(
  file: UsageHistoryFile,
  options: UsageWindow,
): UsageHistorySummary {
  const from = windowStart(options);
  const keys = daysInWindow(Object.keys(file.days), options);
  const days = keys.map((day): UsageDayLine => {
    const rows = file.days[day] ?? [];
    const models = rows
      .map((r): UsageModelLine => ({
        billing: r.billing,
        providerId: r.providerId,
        model: r.model,
        ...totalsOf([r]),
      }))
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    const seen = file.sessions?.[day];
    return { day, ...totalsOf(rows), models, sessions: seen ? seen.length : null };
  });
  const counted = keys.filter((d) => file.sessions?.[d] !== undefined);
  const sessions = counted.length === 0 ? null : new Set(counted.flatMap((d) => file.sessions?.[d] ?? [])).size;
  return { from, to: options.today, days, total: addTotals(days), sessions };
}

/** The table `atomic-agent usage` prints. */
export function formatUsageHistory(
  summary: UsageHistorySummary,
  options: { models?: boolean; sessions?: boolean } = {},
): string {
  const range = summary.from === null ? `all days to ${summary.to}` : `${summary.from} to ${summary.to}`;
  if (summary.days.length === 0) {
    return `Token usage, ${range}\n  nothing recorded yet. Every model call is counted from now on.`;
  }
  // ATO-2442: the session count is its own last column, only when asked.
  const header = ["Day", "Calls", "Input", "Output", "Cached", "Local", "Cloud cost", ...(options.sessions ? ["Sessions"] : [])];
  const withSessions = (r: string[], n: number | null | undefined): string[] =>
    options.sessions ? [...r, n === undefined ? "" : n === null ? "-" : String(n)] : r;
  const rows: string[][] = [];
  for (const d of summary.days) {
    rows.push(withSessions(cells(d.day, d), d.sessions));
    if (options.models) {
      for (const m of d.models) rows.push(withSessions(cells(`  ${m.billing} ${m.model}`, m), undefined));
    }
  }
  rows.push(withSessions(cells("Total", summary.total), summary.sessions));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]): string =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ").trimEnd();
  return [
    `Token usage, ${range}`,
    line(header),
    ...rows.map(line),
    "Local: share of tokens a local model served (not billed). Cost counts priced cloud calls only;",
    "a + means some cloud calls had no known price (set llm.userModels[].pricing to count them).",
  ].join("\n");
}

function cells(label: string, t: UsageTotals): string[] {
  const tokens = t.localTokens + t.cloudTokens + t.planTokens;
  return [
    label,
    String(t.calls),
    formatTokenCount(t.inputTokens),
    formatTokenCount(t.outputTokens),
    formatTokenCount(t.cachedTokens),
    tokens > 0 ? `${Math.round((t.localTokens / tokens) * 100)}%` : "-",
    formatCost(t),
  ];
}

function formatCost(t: UsageTotals): string {
  if (t.pricedCalls > 0) return `${formatUsd(t.usd)}${t.unpricedCalls > 0 ? "+" : ""}`;
  if (t.unpricedCalls > 0) return "n/a";
  return "-";
}

/** `950`, `12.3k`, `4.5M`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Sums of rows that carry a billing kind: model rows and project rows alike. */
export function totalsOf(rows: readonly (UsageCounts & { billing: UsageBilling })[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) {
    const tokens = r.inputTokens + r.outputTokens;
    t.calls += r.calls;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cachedTokens += r.cachedTokens;
    if (r.billing === "local") t.localTokens += tokens;
    else if (r.billing === "plan") t.planTokens += tokens;
    else t.cloudTokens += tokens;
    t.usd += r.usd;
    t.pricedCalls += r.pricedCalls;
    t.unpricedCalls += r.unpricedCalls;
  }
  return t;
}

export function addTotals(lines: readonly UsageTotals[]): UsageTotals {
  const t = emptyTotals();
  for (const l of lines) {
    for (const k of Object.keys(t) as (keyof UsageTotals)[]) t[k] += l[k];
  }
  return t;
}

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    localTokens: 0,
    cloudTokens: 0,
    planTokens: 0,
    usd: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
  };
}

export interface UsageWindow {
  days: number | "all";
  today: string;
}

/** The first day of the window, `null` for every day. */
export function windowStart(options: UsageWindow): string | null {
  return options.days === "all" ? null : shiftDay(options.today, -(Math.max(1, options.days) - 1));
}

/** The day keys inside the window, oldest first. */
export function daysInWindow(keys: readonly string[], options: UsageWindow): string[] {
  const from = windowStart(options);
  return keys.filter((d) => d <= options.today && (from === null || d >= from)).sort();
}

/** `YYYY-MM-DD` moved by `delta` calendar days. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
