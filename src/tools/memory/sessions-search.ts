import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MAX_QUERY_CHARS,
  SessionSearchUnavailableError,
  type SearchableChatLine,
  type SessionSearchHit,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "../../session/session-search.js";
import type { ToolDefinition } from "../tool-registry.js";

export const SESSIONS_SEARCH_TOOL = "memory.sessions.search";

/** What the tool reads: the session store's search and its chat lines. */
export interface SessionsSearchSource {
  searchTranscripts(options: SessionSearchOptions): SessionSearchResult;
  listChatLines(id: string): SearchableChatLine[];
}

export interface SessionsSearchToolOptions {
  source: SessionsSearchSource;
}

/** Lines shown on each side of `line` when reading a session. */
export const READ_DEFAULT_RADIUS = 6;
export const READ_MAX_RADIUS = 20;
/** One line is cut here, and the whole window here. */
export const READ_LINE_MAX_CHARS = 1500;
export const READ_WINDOW_MAX_CHARS = 12_000;

class ArgsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `memory.sessions.search` (ATO-1151, ref ATO-578): the agent finds what
 * was said in past chats, word for word, even when reflection never
 * stored it as a note. Two steps, so a search costs a few short lines
 * and only the chat that matters is read in full:
 *
 *   - `{ query, scope?, limit? }` full-text search (FTS5,
 *     `session/session-search.ts`) over the user messages and closing
 *     replies of every stored session but the current one. Each hit
 *     names the session, its title and the line, with a snippet.
 *   - `{ sessionId, line?, radius? }` the chat lines of one session
 *     around `line` (from the start when it is absent), each cut to
 *     {@link READ_LINE_MAX_CHARS}.
 *
 * Tool calls and tool output are not indexed: the lines are what the
 * person and the agent said to each other. Read-only.
 */
export function buildSessionsSearchTool(
  options: SessionsSearchToolOptions,
): ToolDefinition {
  return {
    name: SESSIONS_SEARCH_TOOL,
    description:
      "Search past chats by their words. Pass `query` (plus optional `scope` 'all' (default) or 'project', `limit` 1..25) to find user messages and agent replies from earlier sessions that contain those words; each hit gives a sessionId and line. Then pass `sessionId` (plus optional `line` and `radius`) to read the lines around a hit. Tool calls and tool output are not searched. The current session is left out of the search.",
    readonly: true,
    untrustedOutput: "past chats",
    async run(rawArgs, ctx) {
      try {
        if (rawArgs.sessionId !== undefined && rawArgs.sessionId !== null) {
          return readSession(options.source, rawArgs);
        }
        return search(options.source, rawArgs, ctx);
      } catch (error) {
        if (error instanceof ArgsError) {
          return compressToolResult({
            tool: SESSIONS_SEARCH_TOOL,
            status: "error",
            output: `validation: ${error.field}: ${error.message}`,
            details: { field: error.field, reason: error.message },
          });
        }
        if (error instanceof SessionSearchUnavailableError) {
          return compressToolResult({
            tool: SESSIONS_SEARCH_TOOL,
            status: "error",
            output: error.message,
            details: { reason: "unavailable" },
          });
        }
        throw error;
      }
    },
  };
}

function search(
  source: SessionsSearchSource,
  args: Record<string, unknown>,
  ctx: { sessionId: string; workingDir: string },
) {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ArgsError("query", "pass a non-empty `query`, or a `sessionId` to read");
  }
  if (query.length > SESSION_SEARCH_MAX_QUERY_CHARS) {
    throw new ArgsError("query", `at most ${SESSION_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  const scope = args.scope ?? "all";
  if (scope !== "all" && scope !== "project") {
    throw new ArgsError("scope", "must be 'all' or 'project'");
  }
  const limit = coercePositiveInt(args.limit, "limit");
  const result = source.searchTranscripts({
    query,
    excludeSessionId: ctx.sessionId,
    ...(limit === undefined ? {} : { limit: Math.min(limit, SESSION_SEARCH_MAX_LIMIT) }),
    ...(scope === "project" ? { workingDir: ctx.workingDir } : {}),
  });
  const pendingNote =
    result.pending > 0
      ? `\n(${result.pending} recently changed chats are not indexed yet; searching again covers more of them)`
      : "";
  if (result.hits.length === 0) {
    return compressToolResult({
      tool: SESSIONS_SEARCH_TOOL,
      status: "ok",
      output: `(no past chat matched "${query.slice(0, 60)}")${pendingNote}`,
      details: { query, scope, count: 0, hits: [], pending: result.pending },
    });
  }
  const sessions = new Set(result.hits.map((hit) => hit.sessionId)).size;
  const lines = [
    `${result.hits.length} match(es) in ${sessions} past chat(s), best first:`,
    ...result.hits.map(renderHit),
    `Read around a hit with {"sessionId":"<id>","line":<n>}.${pendingNote}`,
  ];
  return compressToolResult(
    {
      tool: SESSIONS_SEARCH_TOOL,
      status: "ok",
      output: lines.join("\n"),
      details: {
        query,
        scope,
        count: result.hits.length,
        hits: result.hits,
        pending: result.pending,
      },
    },
    { maxSummaryLength: 6000, maxTailLines: 200 },
  );
}

function readSession(source: SessionsSearchSource, args: Record<string, unknown>) {
  const sessionId = args.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new ArgsError("sessionId", "must be a session id from a search hit");
  }
  const line = coerceNonNegativeInt(args.line, "line");
  const radius = Math.min(
    coercePositiveInt(args.radius, "radius") ?? READ_DEFAULT_RADIUS,
    READ_MAX_RADIUS,
  );
  const all = source.listChatLines(sessionId.trim());
  if (all.length === 0) {
    return compressToolResult({
      tool: SESSIONS_SEARCH_TOOL,
      status: "ok",
      output: `(no chat lines in session ${sessionId})`,
      details: { sessionId, count: 0, lines: [] },
    });
  }
  const center = line === undefined ? radius : Math.min(line, all.length - 1);
  const from = Math.max(0, center - radius);
  const to = Math.min(all.length, center + radius + 1);
  const rendered: string[] = [];
  let total = 0;
  let cut = false;
  for (let i = from; i < to; i += 1) {
    const entry = all[i]!;
    const text = clip(entry.text, READ_LINE_MAX_CHARS);
    const row = `#${i} ${entry.kind === "user" ? "user" : "agent"}: ${text}`;
    if (total + row.length > READ_WINDOW_MAX_CHARS && rendered.length > 0) {
      cut = true;
      break;
    }
    rendered.push(row);
    total += row.length;
  }
  const shownTo = from + rendered.length;
  const header = `session ${sessionId}: lines ${from}..${shownTo - 1} of ${all.length}`;
  const more =
    shownTo < all.length || from > 0 || cut
      ? `\n(more: pass "line" to move, "radius" up to ${READ_MAX_RADIUS})`
      : "";
  return compressToolResult(
    {
      tool: SESSIONS_SEARCH_TOOL,
      status: "ok",
      output: `${header}\n${rendered.join("\n")}${more}`,
      details: { sessionId, from, to: shownTo, total: all.length },
    },
    { maxSummaryLength: READ_WINDOW_MAX_CHARS + 500, maxTailLines: 400 },
  );
}

function renderHit(hit: SessionSearchHit, index: number): string {
  const when = new Date(hit.updatedAt).toISOString().slice(0, 10);
  const title = hit.title === null ? "" : ` "${clip(hit.title, 80)}"`;
  const who = hit.kind === "user" ? "user" : "agent";
  const snippet = hit.snippet.replace(/\s+/g, " ").trim();
  return `[${index + 1}] sessionId=${hit.sessionId}${title} (${when}, ${hit.workingDir}) line ${hit.line} ${who}: ${snippet}`;
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
