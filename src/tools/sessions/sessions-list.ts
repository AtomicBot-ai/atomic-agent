import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  sessionSummaryCursorAfter,
  type SessionStore,
  type SessionSummary,
} from "../../session/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import { chatName, limitArg, stringArg } from "./session-access.js";

export interface SessionsListToolOptions {
  sessionStore: Pick<SessionStore, "listSummaryPage">;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** How many rows a `query` may scan before it gives up: bounded, like a page. */
const QUERY_SCAN_ROWS = 500;
const PAGE = 100;

/**
 * `sessions.list { query?, limit? }` — the operator's other chats, newest
 * first: id, status, last activity and name (title, else the opening
 * words). Names only, the same line the sidebar shows; reading a chat's
 * messages is `sessions.read`, which asks first. `query` keeps the chats
 * whose name contains it (case-insensitive).
 */
export function buildSessionsListTool(options: SessionsListToolOptions): ToolDefinition {
  return {
    name: "sessions.list",
    description:
      "List the operator's other chats (id, status, last activity, name). Args: { query?, limit? }. Names only; read a chat with sessions.read.",
    readonly: true,
    async run(rawArgs, ctx) {
      const limit = limitArg(rawArgs.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const query = stringArg(rawArgs.query)?.toLowerCase();
      const rows = query
        ? scanForQuery(options.sessionStore, query, limit)
        : options.sessionStore.listSummaryPage({ limit });
      const lines = rows.map((row) => renderRow(row, ctx.sessionId));
      const output =
        lines.length === 0
          ? query
            ? `(no chat matches "${query}")`
            : "(no chats)"
          : lines.join("\n");
      return compressToolResult(
        {
          tool: "sessions.list",
          status: "ok",
          output,
          details: {
            count: rows.length,
            sessions: rows.map((row) => ({
              id: row.id,
              status: row.status,
              updatedAt: row.updatedAt,
              name: chatName(row),
              current: row.id === ctx.sessionId,
            })),
          },
        },
        { maxSummaryLength: 4000, maxTailLines: MAX_LIMIT + 5 },
      );
    },
  };
}

function scanForQuery(
  store: Pick<SessionStore, "listSummaryPage">,
  query: string,
  limit: number,
): SessionSummary[] {
  const found: SessionSummary[] = [];
  let scanned = 0;
  let page = store.listSummaryPage({ limit: PAGE });
  while (page.length > 0 && found.length < limit && scanned < QUERY_SCAN_ROWS) {
    for (const row of page) {
      if (chatName(row).toLowerCase().includes(query)) found.push(row);
      if (found.length >= limit) break;
    }
    scanned += page.length;
    const after = sessionSummaryCursorAfter(page);
    if (page.length < PAGE || after === null) break;
    page = store.listSummaryPage({ limit: PAGE, after });
  }
  return found;
}

function renderRow(row: SessionSummary, callerId: string): string {
  const when = new Date(row.updatedAt).toISOString().slice(0, 16).replace("T", " ");
  const mine = row.id === callerId ? " (this chat)" : "";
  return `- ${row.id} · ${row.status} · ${when} · ${chatName(row)}${mine}`;
}
