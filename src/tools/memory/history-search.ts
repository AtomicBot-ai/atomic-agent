import { compressToolResult } from "../../compressor/result-compressor.js";
import type {
  HistoryMatch,
  HistorySearchFilters,
} from "../../memory/action-history-search.js";
import { searchActionHistory } from "../../memory/action-history-search.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface HistorySearchToolOptions {
  tracesDir: string;
  maxResults: number;
  /** Current tracing toggle — used to annotate the result with a hint. */
  tracingEnabled: boolean;
}

/**
 * `memory.history.search { tool?, pattern?, since?, until?, limit? }` —
 * scan NDJSON trace files for past `tool_invocation` events. The tool
 * is read-only and never fails: missing directories / disabled tracing
 * surface as `ok` results with an explanatory `details.note`.
 */
export function buildHistorySearchTool(
  options: HistorySearchToolOptions,
): ToolDefinition {
  return {
    name: "memory.history.search",
    description:
      "Search past tool invocations recorded in local trace files. Filters: tool, pattern, since, until, limit.",
    readonly: true,
    async run(rawArgs) {
      const filters = parseFilters(rawArgs);
      const result = searchActionHistory({
        tracesDir: options.tracesDir,
        filters,
        maxResults: options.maxResults,
        tracingEnabled: options.tracingEnabled,
      });
      const output = formatMatches(result.matches, result.note);
      const details: Record<string, unknown> = {
        count: result.matches.length,
        scannedFiles: result.scannedFiles,
        truncated: result.truncated,
        matches: result.matches,
      };
      if (result.note) details.note = result.note;
      return compressToolResult(
        {
          tool: "memory.history.search",
          status: "ok",
          output,
          details,
        },
        { maxSummaryLength: 4000, maxTailLines: 200 },
      );
    },
  };
}

function parseFilters(rawArgs: Record<string, unknown>): HistorySearchFilters {
  const filters: HistorySearchFilters = {};
  if (typeof rawArgs.tool === "string" && rawArgs.tool.length > 0) {
    filters.tool = rawArgs.tool;
  }
  if (typeof rawArgs.pattern === "string" && rawArgs.pattern.length > 0) {
    filters.pattern = rawArgs.pattern;
  }
  if (typeof rawArgs.since === "number" && Number.isFinite(rawArgs.since)) {
    filters.since = rawArgs.since;
  }
  if (typeof rawArgs.until === "number" && Number.isFinite(rawArgs.until)) {
    filters.until = rawArgs.until;
  }
  if (typeof rawArgs.limit === "number" && Number.isFinite(rawArgs.limit)) {
    filters.limit = Math.max(1, Math.floor(rawArgs.limit));
  }
  if (typeof rawArgs.sessionId === "string" && rawArgs.sessionId.length > 0) {
    filters.sessionId = rawArgs.sessionId;
  }
  return filters;
}

function formatMatches(
  matches: readonly HistoryMatch[],
  note: string | undefined,
): string {
  if (matches.length === 0) {
    return note ?? "no matches";
  }
  const lines = matches.map((m) => {
    const when = new Date(m.ts).toISOString();
    return `- ${when} [${m.status}] ${m.tool} (session=${m.sessionId} turn=${m.turnIndex} step=${m.stepIndex}): ${m.summary}`;
  });
  if (note) lines.unshift(`note: ${note}`);
  return lines.join("\n");
}
