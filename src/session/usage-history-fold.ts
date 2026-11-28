import { cleanNumber } from "./usage-history-parse.js";
import {
  USAGE_HISTORY_MAX_PROJECTS_PER_DAY,
  USAGE_HISTORY_MAX_SESSIONS_PER_DAY,
  USAGE_HISTORY_MAX_TOOLS_PER_DAY,
  type UsageBilling,
  type UsageCounts,
  type UsageHistoryFile,
  type UsageHistoryInput,
  type UsageHistoryRow,
  type UsageProjectRef,
  type UsageProjectRow,
} from "./usage-history-types.js";

/**
 * Pure folds of one event into the history (ATO-2352, ATO-2442): a
 * completion into the model, project and session sections of its day,
 * a tool call into the tool section. The store reads, folds, writes.
 *
 * Honesty rules match the session readout: only priced calls add to
 * `usd`; a cloud call with no known price is counted in
 * `unpricedCalls`, never as $0. Local and plan calls keep their tokens
 * and add no dollars.
 */
export interface CompletionFold {
  day: string;
  input: UsageHistoryInput;
  /** The project the call is filed under. */
  project: UsageProjectRef;
  /** The session's short hash, when the call belongs to one. */
  sessionKey?: string;
}

/** `null` when the completion carried no tokens (nothing to count). */
export function foldCompletion(file: UsageHistoryFile, fold: CompletionFold): UsageHistoryFile | null {
  const promptTokens = cleanNumber(fold.input.usage.promptTokens);
  const output = cleanNumber(fold.input.usage.completionTokens);
  if (promptTokens === 0 && output === 0) return null;
  const { day, input, project } = fold;
  const billing: UsageBilling = input.local ? "local" : input.plan ? "plan" : "cloud";
  const priced = input.price.kind === "priced" ? input.price.usd : null;
  const add = (base: UsageCounts): UsageCounts => ({
    calls: base.calls + 1,
    inputTokens: base.inputTokens + promptTokens,
    outputTokens: base.outputTokens + output,
    cachedTokens: base.cachedTokens + cleanNumber(input.usage.cachedTokens),
    usd: base.usd + (priced ?? 0),
    pricedCalls: base.pricedCalls + (priced !== null ? 1 : 0),
    // A per-token cloud call without a price is the only "unknown cost".
    unpricedCalls: base.unpricedCalls + (billing === "cloud" && priced === null ? 1 : 0),
  });

  const model = input.modelId ?? input.providerId;
  const rows = upsert<UsageHistoryRow>(
    file.days[day] ?? [],
    (r) => r.billing === billing && r.providerId === input.providerId && r.model === model,
    (base) => ({ billing, providerId: input.providerId, model, ...add(base ?? ZERO) }),
    Infinity,
  );
  const projectRows = upsert<UsageProjectRow>(
    file.projects?.[day] ?? [],
    (r) => r.billing === billing && r.project === project.key,
    (base) => ({ billing, project: project.key, label: project.label, ...add(base ?? ZERO) }),
    USAGE_HISTORY_MAX_PROJECTS_PER_DAY,
  );
  const next: UsageHistoryFile = {
    ...file,
    days: { ...file.days, [day]: rows },
    projects: { ...file.projects, [day]: projectRows },
  };
  if (fold.sessionKey !== undefined) {
    const seen = file.sessions?.[day] ?? [];
    if (!seen.includes(fold.sessionKey) && seen.length < USAGE_HISTORY_MAX_SESSIONS_PER_DAY) {
      next.sessions = { ...file.sessions, [day]: [...seen, fold.sessionKey] };
    }
  }
  return next;
}

/** One finished tool call. `null` for a turn-ending tool, or when the day already holds the most tools it keeps. */
export function foldToolCall(
  file: UsageHistoryFile,
  day: string,
  tool: string,
  failed: boolean,
): UsageHistoryFile | null {
  const name = tool.trim();
  if (name === "" || UNCOUNTED_TOOLS.has(name)) return null;
  const tools = file.tools?.[day] ?? {};
  const base = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (base === undefined && Object.keys(tools).length >= USAGE_HISTORY_MAX_TOOLS_PER_DAY) return null;
  const count = { calls: (base?.calls ?? 0) + 1, errors: (base?.errors ?? 0) + (failed ? 1 : 0) };
  return { ...file, tools: { ...file.tools, [day]: { ...tools, [name]: count } } };
}

/**
 * The turn's own ends (`TERMINAL_TOOL_NAMES` in agent/step/step-inference.ts):
 * every turn has one, so counting them would only drown the real tools.
 */
const UNCOUNTED_TOOLS = new Set(["reply", "finish"]);

const ZERO: UsageCounts = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  usd: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
};

/** Replace the matching row, or append one while under `cap` (else fold into nothing new). */
function upsert<T>(rows: readonly T[], match: (r: T) => boolean, build: (base: T | undefined) => T, cap: number): T[] {
  const at = rows.findIndex(match);
  if (at >= 0) return rows.map((r, i) => (i === at ? build(r) : r));
  if (rows.length >= cap) return [...rows];
  return [...rows, build(undefined)];
}
