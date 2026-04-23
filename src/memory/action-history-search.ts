import {
  listTraceFiles,
  readToolInvocationsFromFile,
} from "./action-history-reader.js";

export interface HistorySearchFilters {
  /** Exact tool name match (e.g. `os.fs.read`). */
  tool?: string;
  /**
   * Case-insensitive substring pattern matched against the tool name,
   * the JSON-encoded args, and the recorded summary.
   */
  pattern?: string;
  /** Inclusive lower bound on `ts` (epoch ms). */
  since?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  until?: number;
  /** Hard cap on returned matches. Defaults to `20`; clamped to `maxResults`. */
  limit?: number;
  /** Narrow to a single session. */
  sessionId?: string;
}

export interface HistoryMatch {
  sessionId: string;
  ts: number;
  turnIndex: number;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  summary: string;
}

export interface HistorySearchResult {
  matches: HistoryMatch[];
  scannedFiles: number;
  /** True when the result was cut by `limit`. */
  truncated: boolean;
  /**
   * Populated when the traces dir is missing/empty or tracing is off —
   * the tool surfaces this to the LLM so it can report back accurately.
   */
  note?: string;
}

export interface SearchActionHistoryOptions {
  tracesDir: string;
  filters: HistorySearchFilters;
  /**
   * Absolute ceiling on the number of matches ever returned, even if
   * `filters.limit` is higher. Wired from `memory.history.maxResults`.
   */
  maxResults: number;
  /**
   * Whether tracing is currently enabled on the runtime. Disabled
   * runtimes can still have historical traces on disk — we keep serving
   * them but attach a hint so the caller knows new actions won't land.
   */
  tracingEnabled: boolean;
}

const DEFAULT_LIMIT = 20;

/**
 * Search recorded tool invocations across every on-disk session trace.
 *
 * Strategy:
 *  - Enumerate `<tracesDir>/*.ndjson`, sort by mtime desc (newest
 *    session first).
 *  - Scan each file top-to-bottom, filter, push to a buffer.
 *  - Early-exit after `limit * EARLY_EXIT_MULTIPLIER` matches; additional
 *    files can only carry older events which cannot displace newer ones
 *    after the final `ts` sort.
 *  - Sort the buffer by `ts` desc and return the head of `limit`.
 */
export function searchActionHistory(
  options: SearchActionHistoryOptions,
): HistorySearchResult {
  const limit = Math.max(
    1,
    Math.min(options.maxResults, options.filters.limit ?? DEFAULT_LIMIT),
  );
  const files = listTraceFiles(options.tracesDir).sort(
    (a, b) => b.mtimeMs - a.mtimeMs,
  );

  if (files.length === 0) {
    const note = options.tracingEnabled
      ? "no trace files present yet"
      : "tracing is disabled — historical results only";
    return { matches: [], scannedFiles: 0, truncated: false, note };
  }

  const narrowSession = options.filters.sessionId;
  const targetFiles = narrowSession
    ? files.filter((f) => f.sessionId === narrowSession)
    : files;

  const buffer: HistoryMatch[] = [];
  const earlyExitAt = limit * 3;
  let scannedFiles = 0;

  for (const file of targetFiles) {
    scannedFiles += 1;
    const events = readToolInvocationsFromFile(file.path);
    for (const event of events) {
      if (!matchesFilters(event, options.filters)) continue;
      buffer.push({
        sessionId: event.sessionId,
        ts: event.ts,
        turnIndex: event.turnIndex,
        stepIndex: event.stepIndex,
        tool: event.tool,
        args: event.args,
        status: event.status,
        summary: event.summary,
      });
    }
    if (buffer.length >= earlyExitAt) break;
  }

  buffer.sort((a, b) => b.ts - a.ts);
  const matches = buffer.slice(0, limit);

  const result: HistorySearchResult = {
    matches,
    scannedFiles,
    truncated: buffer.length > limit,
  };
  if (!options.tracingEnabled) {
    result.note = "tracing is disabled — historical results only";
  }
  return result;
}

function matchesFilters(
  event: {
    ts: number;
    tool: string;
    args: Record<string, unknown>;
    summary: string;
  },
  filters: HistorySearchFilters,
): boolean {
  if (filters.tool !== undefined && event.tool !== filters.tool) return false;
  if (filters.since !== undefined && event.ts < filters.since) return false;
  if (filters.until !== undefined && event.ts > filters.until) return false;
  if (filters.pattern !== undefined && filters.pattern.length > 0) {
    const needle = filters.pattern.toLowerCase();
    const haystack = `${event.tool}\n${event.summary}\n${safeStringifyArgs(event.args)}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function safeStringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}
