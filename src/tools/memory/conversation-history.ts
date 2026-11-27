import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import { validSessionCompaction } from "../../session/session-compaction.js";
import type { SessionState } from "../../session/session-state.js";
import type { ToolDefinition } from "../tool-registry.js";

export const CONVERSATION_HISTORY_TOOL = "conversation.history";

/** What the tool reads: the stored copy of the current session. */
export interface ConversationHistorySource {
  load(id: string): Pick<SessionState, "turns" | "compaction"> | null;
}

export interface ConversationHistoryToolOptions {
  source: ConversationHistorySource;
}

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_MAX_TERMS = 8;
export const SEARCH_SNIPPET_CHARS = 240;
export const READ_DEFAULT_COUNT = 10;
export const READ_MAX_COUNT = 40;
/** One record is cut here, and the whole window here. */
export const RECORD_MAX_CHARS = 4000;
export const WINDOW_MAX_CHARS = 16_000;
const CALL_ARGS_MAX_CHARS = 400;

class ArgsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `conversation.history` (ATO-2261): find and reread the part of THIS
 * chat that a compaction already replaced with a summary. The summary
 * keeps the gist; this keeps the exact numbers, paths and tool output.
 *
 *   - `{ query, limit? }` word search over the compacted records only
 *     (user messages, replies, tool calls and tool results before
 *     `compaction.coveredThrough`). Each hit names its record index.
 *   - `{ from, count? }` reads records `from..from+count-1`, still only
 *     inside the compacted part, within {@link WINDOW_MAX_CHARS}.
 *
 * Only the calling session (`ctx.sessionId`) is ever read: there is no
 * session argument. Records after the boundary are already in context,
 * so they are never searched or shown. Read-only.
 *
 * Precedent: pi (p2) `history` tool (search up to the compaction
 * boundary, ranged read with a budget, own conversation only) and
 * Prime Agent `rlm.session.messages`.
 */
export function buildConversationHistoryTool(
  options: ConversationHistoryToolOptions,
): ToolDefinition {
  return {
    name: CONVERSATION_HISTORY_TOOL,
    description:
      "Search or reread the earlier part of this chat that was compacted into a summary. Pass `query` (plus optional `limit` 1..20) to find words in it, including tool calls and tool output; each hit gives a record number. Then pass `from` (plus optional `count` 1..40) to read records from there. Only this chat, only what the summary replaced.",
    readonly: true,
    async run(rawArgs, ctx) {
      try {
        const state = options.source.load(ctx.sessionId);
        const checkpoint = state ? validSessionCompaction(state) : null;
        if (!state || !checkpoint) {
          return compressToolResult({
            tool: CONVERSATION_HISTORY_TOOL,
            status: "ok",
            output: "(nothing in this chat has been compacted yet: all of it is still in your context)",
            details: { compacted: 0 },
          });
        }
        const records = state.turns.slice(0, checkpoint.coveredThrough);
        if (rawArgs.from !== undefined && rawArgs.from !== null) {
          return readRecords(records, rawArgs);
        }
        return searchRecords(records, rawArgs);
      } catch (error) {
        if (error instanceof ArgsError) {
          return compressToolResult({
            tool: CONVERSATION_HISTORY_TOOL,
            status: "error",
            output: `validation: ${error.field}: ${error.message}`,
            details: { field: error.field, reason: error.message },
          });
        }
        throw error;
      }
    },
  };
}

/** One record as one line of text: who, then what. */
export function renderRecord(turn: ConversationTurn): string {
  switch (turn.kind) {
    case "user":
      return `user: ${turn.text}`;
    case "assistant_reply":
      return `agent: ${turn.text}`;
    case "assistant_tool_call":
      return `call ${turn.tool} ${clip(safeJson(turn.args), CALL_ARGS_MAX_CHARS)}`;
    case "tool_result":
      return `result ${turn.tool} (${turn.status}): ${turn.summary}`;
    default:
      return "";
  }
}

export function searchTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return [...new Set(terms)].slice(0, SEARCH_MAX_TERMS);
}

function searchRecords(records: readonly ConversationTurn[], args: Record<string, unknown>) {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ArgsError("query", "pass a non-empty `query`, or `from` to read");
  }
  const terms = searchTerms(query);
  const limit = Math.min(coercePositiveInt(args.limit, "limit") ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
  const scored: Array<{ index: number; score: number; text: string; at: number }> = [];
  records.forEach((turn, index) => {
    const text = renderRecord(turn);
    const lower = text.toLowerCase();
    let score = 0;
    let at = -1;
    for (const term of terms) {
      const pos = lower.indexOf(term);
      if (pos < 0) continue;
      score += 1;
      if (at < 0 || pos < at) at = pos;
    }
    if (score > 0) scored.push({ index, score, text, at });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const hits = scored.slice(0, limit);
  if (hits.length === 0) {
    return compressToolResult({
      tool: CONVERSATION_HISTORY_TOOL,
      status: "ok",
      output: `(no compacted record of this chat matched "${query.slice(0, 60)}"; records 0..${records.length - 1} were searched)`,
      details: { query, compacted: records.length, count: 0, hits: [] },
    });
  }
  const lines = [
    `${hits.length} match(es) in the compacted part of this chat (records 0..${records.length - 1}), best first:`,
    ...hits.map((hit) => `#${hit.index} ${snippet(hit.text, hit.at)}`),
    `Read around a hit with {"from":<n>}.`,
  ];
  return compressToolResult(
    {
      tool: CONVERSATION_HISTORY_TOOL,
      status: "ok",
      output: lines.join("\n"),
      details: {
        query,
        compacted: records.length,
        count: hits.length,
        hits: hits.map((hit) => ({ index: hit.index, score: hit.score })),
      },
    },
    { maxSummaryLength: 6000, maxTailLines: 200 },
  );
}

function readRecords(records: readonly ConversationTurn[], args: Record<string, unknown>) {
  const from = coerceNonNegativeInt(args.from, "from") ?? 0;
  if (from >= records.length) {
    throw new ArgsError("from", `the compacted part has records 0..${records.length - 1}`);
  }
  const count = Math.min(coercePositiveInt(args.count, "count") ?? READ_DEFAULT_COUNT, READ_MAX_COUNT);
  const end = Math.min(records.length, from + count);
  const rendered: string[] = [];
  let total = 0;
  for (let i = from; i < end; i += 1) {
    const row = `#${i} ${clip(renderRecord(records[i]!), RECORD_MAX_CHARS)}`;
    if (total + row.length > WINDOW_MAX_CHARS && rendered.length > 0) break;
    rendered.push(row);
    total += row.length;
  }
  const shownTo = from + rendered.length;
  const more =
    shownTo < records.length
      ? `\n(more: {"from":${shownTo}}; records after ${records.length - 1} are already in your context)`
      : "";
  return compressToolResult(
    {
      tool: CONVERSATION_HISTORY_TOOL,
      status: "ok",
      output: `compacted records ${from}..${shownTo - 1} of 0..${records.length - 1}:\n${rendered.join("\n")}${more}`,
      details: { from, to: shownTo, compacted: records.length },
    },
    { maxSummaryLength: WINDOW_MAX_CHARS + 500, maxTailLines: 400 },
  );
}

function snippet(text: string, at: number): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= SEARCH_SNIPPET_CHARS) return flat;
  const start = Math.max(0, Math.min(at - SEARCH_SNIPPET_CHARS / 3, flat.length - SEARCH_SNIPPET_CHARS));
  const body = flat.slice(start, start + SEARCH_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${body}${start + SEARCH_SNIPPET_CHARS < flat.length ? "…" : ""}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function coercePositiveInt(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ArgsError(field, "must be a positive integer");
}

function coerceNonNegativeInt(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ArgsError(field, "must be a non-negative integer");
}
