import type { CompletionUsage } from "../llm/provider/completion-types.js";
import type { CompletionPrice } from "./usage-meter.js";

/**
 * The shape of `<stateDir>/usage-history.json` (ATO-2352, ATO-2442).
 *
 * `days` is the first slice's table and is never changed: an older
 * build reads and writes it as before. The other maps came later
 * (ATO-2442) and are optional, so a file written before them still
 * loads, and an older build that rewrites the file only drops them.
 * The version stays 1 on purpose: a bump would make every older build
 * stop counting (it refuses to overwrite a newer file).
 *
 * Only counts, model ids, tool names, a project folder's name with a
 * short hash of its path, and a short hash of each session id are
 * stored: no prompt, no reply, no full path.
 */
export type UsageBilling = "cloud" | "local" | "plan";

/** What every kind of row adds up. */
export interface UsageCounts {
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

export interface UsageHistoryRow extends UsageCounts {
  billing: UsageBilling;
  providerId: string;
  /** The served model id, else the provider id when the service named none. */
  model: string;
}

/** One project's tokens for one day and billing kind (ATO-2442). */
export interface UsageProjectRow extends UsageCounts {
  billing: UsageBilling;
  /** A short hash of the project folder's full path; `-` for calls outside any chat. */
  project: string;
  /** The folder's own name, for display. */
  label: string;
}

/** Tool calls of one tool on one day (ATO-2442). */
export interface UsageToolCount {
  calls: number;
  errors: number;
}

export interface UsageHistoryFile {
  version: 1;
  /** `YYYY-MM-DD` (the spend day, same reset hour as the daily ceiling) → rows. */
  days: Record<string, UsageHistoryRow[]>;
  /** Day → tokens per project folder. Absent in a file from before ATO-2442. */
  projects?: Record<string, UsageProjectRow[]>;
  /** Day → tool name → calls. Absent in a file from before ATO-2442. */
  tools?: Record<string, Record<string, UsageToolCount>>;
  /** Day → short hashes of the sessions that made a model call that day. */
  sessions?: Record<string, string[]>;
}

export interface UsageHistoryInput {
  providerId: string;
  modelId: string | null;
  /** The completion's tokens: the usage block, or a local server's timings. */
  usage: CompletionUsage;
  local: boolean;
  plan: boolean;
  price: CompletionPrice;
  /** The chat the call belongs to, when there is one (ATO-2442). */
  sessionId?: string;
}

/** Where a session's calls are filed: a project folder, or none. */
export interface UsageProjectRef {
  key: string;
  label: string;
}

export const USAGE_HISTORY_FILE_NAME = "usage-history.json";
/** Days kept; older days are dropped on the next write. */
export const USAGE_HISTORY_MAX_DAYS = 400;
/** Distinct tools kept per day; a runaway MCP catalogue cannot grow the file without bound. */
export const USAGE_HISTORY_MAX_TOOLS_PER_DAY = 300;
/** Distinct projects kept per day and billing kind. */
export const USAGE_HISTORY_MAX_PROJECTS_PER_DAY = 200;
/** Distinct sessions kept per day. */
export const USAGE_HISTORY_MAX_SESSIONS_PER_DAY = 5000;
/** The project key of calls that belong to no chat (memory upkeep, side calls). */
export const USAGE_NO_PROJECT_KEY = "-";
