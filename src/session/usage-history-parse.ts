import { readFileSync } from "node:fs";

import {
  USAGE_HISTORY_MAX_DAYS,
  type UsageBilling,
  type UsageCounts,
  type UsageHistoryFile,
  type UsageHistoryRow,
  type UsageProjectRow,
  type UsageToolCount,
} from "./usage-history-types.js";

/**
 * Reading `usage-history.json` (ATO-2352, ATO-2442). Every field is
 * checked: a damaged row is dropped, a damaged section reads as empty,
 * and a file from before the project / tool / session sections loads
 * with those sections empty.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The history at `path` for the report; a missing or damaged file reads as empty. */
export function readUsageHistory(path: string): UsageHistoryFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { version: 1, days: {} };
  }
  return parseUsageHistory(raw);
}

/**
 * The history at `path` before a write: empty only when the file does
 * not exist yet, `null` when it exists but must not be replaced (any
 * other read error, unparseable JSON, a newer `version`).
 */
export function readUsageHistoryForWrite(path: string): UsageHistoryFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { version: 1, days: {} } : null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > 1) return null;
  return parseUsageHistory(raw);
}

export function parseUsageHistory(raw: unknown): UsageHistoryFile {
  const source = raw as Partial<Record<keyof UsageHistoryFile, unknown>> | null;
  const file: UsageHistoryFile = { version: 1, days: perDay(source?.days, rowsOf(cleanRow)) };
  const projects = perDay(source?.projects, rowsOf(cleanProjectRow));
  const tools = perDay(source?.tools, cleanTools);
  const sessions = perDay(source?.sessions, cleanSessions);
  if (Object.keys(projects).length > 0) file.projects = projects;
  if (Object.keys(tools).length > 0) file.tools = tools;
  if (Object.keys(sessions).length > 0) file.sessions = sessions;
  return file;
}

/** Only the newest `USAGE_HISTORY_MAX_DAYS` days, in every section. */
export function pruneUsageHistory(file: UsageHistoryFile): UsageHistoryFile {
  const all = new Set([
    ...Object.keys(file.days),
    ...Object.keys(file.projects ?? {}),
    ...Object.keys(file.tools ?? {}),
    ...Object.keys(file.sessions ?? {}),
  ]);
  if (all.size <= USAGE_HISTORY_MAX_DAYS) return file;
  const keep = new Set([...all].sort().slice(-USAGE_HISTORY_MAX_DAYS));
  const pick = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined =>
    map === undefined ? undefined : Object.fromEntries(Object.entries(map).filter(([day]) => keep.has(day)));
  const out: UsageHistoryFile = { version: 1, days: pick(file.days) ?? {} };
  const projects = pick(file.projects);
  const tools = pick(file.tools);
  const sessions = pick(file.sessions);
  if (projects) out.projects = projects;
  if (tools) out.tools = tools;
  if (sessions) out.sessions = sessions;
  return out;
}

function perDay<T>(value: unknown, clean: (v: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [day, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY.test(day)) continue;
    const kept = clean(entry);
    if (kept !== null) out[day] = kept;
  }
  return out;
}

function rowsOf<T>(clean: (v: unknown) => T | null): (v: unknown) => T[] | null {
  return (v) => {
    if (!Array.isArray(v)) return null;
    const kept = v.map(clean).filter((r): r is T => r !== null);
    return kept.length > 0 ? kept : null;
  };
}

function cleanRow(value: unknown): UsageHistoryRow | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<UsageHistoryRow>;
  if (!isBilling(r.billing)) return null;
  if (typeof r.model !== "string" || typeof r.providerId !== "string") return null;
  return { billing: r.billing, providerId: r.providerId, model: r.model, ...cleanCounts(r) };
}

function cleanProjectRow(value: unknown): UsageProjectRow | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<UsageProjectRow>;
  if (!isBilling(r.billing)) return null;
  if (typeof r.project !== "string" || r.project === "" || typeof r.label !== "string") return null;
  return { billing: r.billing, project: r.project, label: r.label, ...cleanCounts(r) };
}

function cleanTools(value: unknown): Record<string, UsageToolCount> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, UsageToolCount> = {};
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    if (name === "" || !count || typeof count !== "object") continue;
    const c = count as Partial<UsageToolCount>;
    const calls = cleanNumber(c.calls);
    if (calls > 0) out[name] = { calls, errors: Math.min(calls, cleanNumber(c.errors)) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function cleanSessions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const kept = [...new Set(value.filter((v): v is string => typeof v === "string" && v !== ""))];
  return kept.length > 0 ? kept : null;
}

function cleanCounts(r: Partial<UsageCounts>): UsageCounts {
  return {
    calls: cleanNumber(r.calls),
    inputTokens: cleanNumber(r.inputTokens),
    outputTokens: cleanNumber(r.outputTokens),
    cachedTokens: cleanNumber(r.cachedTokens),
    usd: cleanNumber(r.usd),
    pricedCalls: cleanNumber(r.pricedCalls),
    unpricedCalls: cleanNumber(r.unpricedCalls),
  };
}

function isBilling(value: unknown): value is UsageBilling {
  return value === "cloud" || value === "local" || value === "plan";
}

export function cleanNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
