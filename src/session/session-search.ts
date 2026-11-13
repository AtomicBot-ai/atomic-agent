import type Database from "better-sqlite3";
import { SESSION_TITLE_METADATA_KEY } from "./session-title.js";
import {
  FUSION_WORKER_ID_PREFIX,
  FUSION_WORKER_METADATA_KEY,
} from "./fusion-worker-session.js";

/**
 * Full-text search over stored chats (ATO-1149): the user messages and
 * closing replies of every session, the same lines `listChatLines`
 * reads, indexed with SQLite FTS5.
 *
 * The index lives beside `sessions` in the same file, and it is filled
 * lazily, at search time, rather than on every write: a session is
 * (re)indexed when its `updated_at` differs from the one it was last
 * indexed at. That keeps the write path (`SessionStore.write`, turn
 * marks, checkpoints, the turn archive) exactly as it was, backfills the
 * sessions written before this existed, and catches rows another process
 * wrote or a retention prune removed. The cost is paid by the search
 * that first sees a change, bounded per call by
 * {@link SYNC_BATCH}; the rest waits for the next search and is
 * reported as `pending`. Transcripts are read outside the write lock and
 * the index is written {@link SYNC_TX_SESSIONS} sessions per
 * transaction, so a backfill never holds the lock long enough for a
 * concurrent message append to hit its busy timeout.
 *
 * Which sessions are searched (decision 73): every channel, each hit
 * labelled with its `source` (`chat`, `telegram`, `discord`, `webhook`,
 * `task`, `imported`); scheduled-task sessions rank lower; incognito
 * chats (ATO-586), Fusion workers and sessions stamped
 * `metadata.internal` / `metadata.subagent` are never indexed, so no
 * search or read can return them. See {@link classifySessionForSearch}.
 *
 * Lines go into a plain table (`session_search_lines`, indexed by
 * session) with the FTS5 table as its external-content index, so a
 * session's lines are replaced with indexed deletes and not a scan of
 * the FTS table.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_search_lines (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_search_lines_session
  ON session_search_lines(session_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
  text,
  content='session_search_lines',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS session_search_lines_ai
AFTER INSERT ON session_search_lines BEGIN
  INSERT INTO session_search_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS session_search_lines_ad
AFTER DELETE ON session_search_lines BEGIN
  INSERT INTO session_search_fts(session_search_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS session_search_state (
  session_id         TEXT PRIMARY KEY,
  indexed_updated_at INTEGER NOT NULL,
  source             TEXT
);
`;

/** Sessions (re)indexed by one search at most; the rest wait for the next. */
export const SYNC_BATCH = 500;

/** Sessions written per index transaction (the write lock is held this long). */
export const SYNC_TX_SESSIONS = 25;

/**
 * bm25 is negative (lower is better); a task session's score is scaled by
 * this, so it ranks below an interactive chat that matches as well.
 */
export const TASK_RANK_FACTOR = 0.5;

/** Where a searchable session came from, for a label beside each hit. */
export type SessionSearchSource =
  | "chat"
  | "telegram"
  | "discord"
  | "webhook"
  | "task"
  | "imported";

/** Hits one search returns by default, and at most. */
export const SESSION_SEARCH_DEFAULT_LIMIT = 10;
export const SESSION_SEARCH_MAX_LIMIT = 25;

/** Hits from one session at most, so one long chat cannot fill the page. */
export const SESSION_SEARCH_PER_SESSION = 3;

/** Longest query accepted, in characters. */
export const SESSION_SEARCH_MAX_QUERY_CHARS = 500;

/** One chat line, as `listChatLines` hands it back. */
export interface SearchableChatLine {
  kind: "user" | "assistant_reply";
  text: string;
}

export interface SessionSearchOptions {
  query: string;
  /** Hits at most; clamped to 1..{@link SESSION_SEARCH_MAX_LIMIT}. */
  limit?: number;
  /** Only sessions in this working directory. */
  workingDir?: string;
  /** Leave this session out (the one the agent is searching from). */
  excludeSessionId?: string;
}

export interface SessionSearchHit {
  sessionId: string;
  title: string | null;
  workingDir: string;
  updatedAt: number;
  /** Position of the line among the session's chat lines (`listChatLines`). */
  line: number;
  kind: "user" | "assistant_reply";
  /** The matching part of the line, terms wrapped in `«` and `»`. */
  snippet: string;
  /** Where the session came from. */
  source: SessionSearchSource;
}

export interface SessionSearchResult {
  hits: SessionSearchHit[];
  /** Sessions changed since they were indexed that this search did not reach. */
  pending: number;
}

/** Raised when the index cannot be created (no FTS5, a read-only file). */
export class SessionSearchUnavailableError extends Error {
  constructor(reason: string) {
    super(`session search is unavailable: ${reason}`);
    this.name = "SessionSearchUnavailableError";
  }
}

interface HitRow {
  sessionId: string;
  ord: number;
  kind: string;
  snippet: string;
  updatedAt: number;
  workingDir: string;
  title: unknown;
  source: unknown;
}

/** What classification reads off a row, projected in SQL. */
export interface ClassifyRow {
  id: string;
  /** `json_type(payload, '$.incognito')`; `null` for an unreadable payload. */
  incognitoType: unknown;
  /** `json_extract(payload, '$.metadata')`: JSON text, or `null`. */
  metadata: unknown;
}

interface StaleRow extends ClassifyRow {
  updatedAt: number;
}

/**
 * The SQL columns {@link classifySessionForSearch} reads, guarded so a
 * payload that is not JSON never reaches `json_extract`.
 */
const CLASSIFY_COLUMNS = `
  s.id AS id,
  CASE WHEN json_valid(s.payload) THEN json_type(s.payload, '$.incognito') END AS incognitoType,
  CASE WHEN json_valid(s.payload) AND json_type(s.payload, '$.metadata') = 'object'
       THEN json_extract(s.payload, '$.metadata') END AS metadata`;

/**
 * The source label of a session, or `null` when it must never be
 * searched: an incognito chat (`incognito` is an object, ATO-586), a
 * Fusion worker (`s-w-` id or the `fusionWorker` stamp), or a session
 * stamped `metadata.internal: true` or `metadata.subagent`. Task sessions
 * are the ones the task runner and the scheduler create
 * (`recurringTask`, `ephemeralTask`, `overnight`, `source: "http-task"`).
 */
export function classifySessionForSearch(row: ClassifyRow): SessionSearchSource | null {
  if (row.incognitoType === "object") return null;
  if (row.id.startsWith(FUSION_WORKER_ID_PREFIX)) return null;
  let meta: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // A metadata bag that will not parse reads as an ordinary chat.
    }
  }
  const set = (key: string): boolean =>
    meta[key] !== undefined && meta[key] !== null && meta[key] !== false;
  if (set(FUSION_WORKER_METADATA_KEY) || meta.internal === true || set("subagent")) {
    return null;
  }
  if (set("telegramChannel")) return "telegram";
  if (set("discordChannel")) return "discord";
  if (set("webhookName")) return "webhook";
  if (
    set("recurringTask") ||
    set("ephemeralTask") ||
    meta.overnight === true ||
    meta.source === "http-task"
  ) {
    return "task";
  }
  if (set("importedFrom")) return "imported";
  return "chat";
}

/**
 * The searchable source of stored session `id`, or `null` when it is
 * hidden from search or not stored. A plain read, no index needed.
 */
export function searchableSessionSource(
  db: Database.Database,
  id: string,
): SessionSearchSource | null {
  const row = db
    .prepare(`SELECT ${CLASSIFY_COLUMNS} FROM sessions AS s WHERE s.id = ?`)
    .get(id) as ClassifyRow | undefined;
  return row === undefined ? null : classifySessionForSearch(row);
}

const SOURCES: ReadonlySet<string> = new Set([
  "chat",
  "telegram",
  "discord",
  "webhook",
  "task",
  "imported",
]);

/** Whether the index tables exist (a read; never takes the write lock). */
export function sessionSearchTablesExist(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_search_state'`,
    )
    .get();
  return row !== undefined;
}

/**
 * Drop one session's lines from the index, when the index exists. Called
 * from `SessionStore.delete`, so a deleted chat's text does not wait for
 * the next search to leave the file.
 */
export function forgetSessionSearchRows(db: Database.Database, id: string): void {
  if (!sessionSearchTablesExist(db)) return;
  db.prepare(`DELETE FROM session_search_lines WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM session_search_state WHERE session_id = ?`).run(id);
}

export class SessionSearchIndex {
  private readonly staleStmt: Database.Statement;
  private readonly countStaleStmt: Database.Statement;
  private readonly orphanLinesStmt: Database.Statement;
  private readonly orphanStateStmt: Database.Statement;
  private readonly clearLinesStmt: Database.Statement;
  private readonly insertLineStmt: Database.Statement;
  private readonly upsertStateStmt: Database.Statement;
  private readonly currentStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly listChatLines: (id: string) => SearchableChatLine[],
  ) {
    try {
      db.exec(SCHEMA);
    } catch (err) {
      throw new SessionSearchUnavailableError(
        err instanceof Error ? err.message : String(err),
      );
    }
    const stale = `
      FROM sessions AS s
      LEFT JOIN session_search_state AS st ON st.session_id = s.id
     WHERE st.session_id IS NULL OR st.indexed_updated_at <> s.updated_at`;
    this.staleStmt = db.prepare(
      `SELECT ${CLASSIFY_COLUMNS}, s.updated_at AS updatedAt ${stale}
       ORDER BY s.updated_at DESC LIMIT ?`,
    );
    this.countStaleStmt = db.prepare(`SELECT COUNT(*) AS n ${stale}`);
    const orphan = `NOT EXISTS (SELECT 1 FROM sessions AS s WHERE s.id = session_id)`;
    this.orphanLinesStmt = db.prepare(
      `DELETE FROM session_search_lines
        WHERE session_id IN (SELECT session_id FROM session_search_state WHERE ${orphan})`,
    );
    this.orphanStateStmt = db.prepare(
      `DELETE FROM session_search_state WHERE ${orphan}`,
    );
    this.clearLinesStmt = db.prepare(
      `DELETE FROM session_search_lines WHERE session_id = ?`,
    );
    this.insertLineStmt = db.prepare(
      `INSERT INTO session_search_lines (session_id, ord, kind, text)
       VALUES (@sessionId, @ord, @kind, @text)`,
    );
    this.upsertStateStmt = db.prepare(
      `INSERT INTO session_search_state (session_id, indexed_updated_at, source)
       VALUES (@sessionId, @updatedAt, @source)
       ON CONFLICT(session_id) DO UPDATE SET
         indexed_updated_at = excluded.indexed_updated_at,
         source = excluded.source`,
    );
    this.currentStmt = db.prepare(
      `SELECT updated_at AS updatedAt FROM sessions WHERE id = ?`,
    );
    // `json_extract` raises on a payload that is not JSON; the `CASE`
    // keeps it off such a row (its lines were never indexed anyway, but
    // a row can go bad after it was).
    this.searchStmt = db.prepare(
      `SELECT l.session_id AS sessionId,
              l.ord AS ord,
              l.kind AS kind,
              snippet(session_search_fts, 0, '«', '»', '…', 24) AS snippet,
              s.updated_at AS updatedAt,
              s.working_dir AS workingDir,
              st.source AS source,
              CASE WHEN json_valid(s.payload)
                   THEN json_extract(s.payload, '$.metadata.${SESSION_TITLE_METADATA_KEY}')
              END AS title
         FROM session_search_fts
         JOIN session_search_lines AS l ON l.id = session_search_fts.rowid
         JOIN sessions AS s ON s.id = l.session_id
         JOIN session_search_state AS st ON st.session_id = l.session_id
        WHERE session_search_fts MATCH @match
          AND st.source IS NOT NULL
          AND (@exclude IS NULL OR l.session_id <> @exclude)
          AND (@workingDir IS NULL OR s.working_dir = @workingDir)
        ORDER BY bm25(session_search_fts)
                   * (CASE WHEN st.source = 'task' THEN ${TASK_RANK_FACTOR} ELSE 1.0 END) ASC,
                 s.updated_at DESC
        LIMIT @scan`,
    );
  }

  /**
   * Bring the index up to date with `sessions`, at most `budget` sessions
   * per call, newest first. Returns how many changed sessions are left.
   *
   * Each round reads up to {@link SYNC_TX_SESSIONS} transcripts with no
   * write lock held (WAL readers do not block writers), then writes their
   * lines in one short `IMMEDIATE` transaction. A session written again
   * in between is left for the next round, which reads it afresh; one
   * deleted in between is skipped (the orphan pass removes what is left).
   */
  sync(budget: number = SYNC_BATCH): number {
    this.db
      .transaction(() => {
        this.orphanLinesStmt.run();
        this.orphanStateStmt.run();
      })
      .immediate();
    let seen = 0;
    while (seen < budget) {
      const rows = this.staleStmt.all(
        Math.min(SYNC_TX_SESSIONS, budget - seen),
      ) as StaleRow[];
      if (rows.length === 0) break;
      seen += rows.length;
      const prepared = rows.map((row) => {
        const source = classifySessionForSearch(row);
        return {
          row,
          source,
          lines: source === null ? [] : this.listChatLines(row.id),
        };
      });
      this.db
        .transaction(() => {
          for (const { row, source, lines } of prepared) {
            const current = this.currentStmt.get(row.id) as
              | { updatedAt: number }
              | undefined;
            if (current === undefined || current.updatedAt !== row.updatedAt) continue;
            this.clearLinesStmt.run(row.id);
            lines.forEach((line, ord) => {
              if (line.text.trim().length === 0) return;
              this.insertLineStmt.run({ sessionId: row.id, ord, kind: line.kind, text: line.text });
            });
            // A hidden session gets a state row with no source and no
            // lines, so it is not read again until it changes.
            this.upsertStateStmt.run({ sessionId: row.id, updatedAt: row.updatedAt, source });
          }
        })
        .immediate();
    }
    return (this.countStaleStmt.get() as { n: number }).n;
  }

  search(options: SessionSearchOptions): SessionSearchResult {
    let pending: number;
    try {
      pending = this.sync();
    } catch {
      // Another process held the write lock past the busy timeout: keep
      // the rounds already written, search what is indexed, and say how
      // much of it may be behind.
      pending = (this.countStaleStmt.get() as { n: number }).n;
    }
    const limit = clampLimit(options.limit);
    const terms = searchTerms(options.query);
    if (terms.length === 0) return { hits: [], pending };
    // Every term first; when that finds nothing, any of them.
    let hits = this.run(terms.join(" AND "), options, limit);
    if (hits.length === 0 && terms.length > 1) {
      hits = this.run(terms.join(" OR "), options, limit);
    }
    return { hits, pending };
  }

  private run(
    match: string,
    options: SessionSearchOptions,
    limit: number,
  ): SessionSearchHit[] {
    const rows = this.searchStmt.all({
      match,
      exclude: options.excludeSessionId ?? null,
      workingDir: options.workingDir ?? null,
      scan: limit * SESSION_SEARCH_PER_SESSION * 4,
    }) as HitRow[];
    const perSession = new Map<string, number>();
    const hits: SessionSearchHit[] = [];
    for (const row of rows) {
      if (typeof row.source !== "string" || !SOURCES.has(row.source)) continue;
      const seen = perSession.get(row.sessionId) ?? 0;
      if (seen >= SESSION_SEARCH_PER_SESSION) continue;
      perSession.set(row.sessionId, seen + 1);
      hits.push({
        sessionId: row.sessionId,
        title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title.trim() : null,
        workingDir: row.workingDir,
        updatedAt: row.updatedAt,
        line: row.ord,
        kind: row.kind === "user" ? "user" : "assistant_reply",
        snippet: row.snippet,
        source: row.source as SessionSearchSource,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(raw)), SESSION_SEARCH_MAX_LIMIT);
}

/**
 * The query as FTS5 terms. FTS5 has its own query language (`-`, `"`,
 * `(`, `*`, `NEAR`, column filters), and what a person or a model types
 * is not meant as that: words are lifted out on anything that is not a
 * letter or digit and each one is quoted as a prefix term, the way the
 * notes store does it (`memory-store.ts`).
 */
export function searchTerms(query: string): string[] {
  return query
    .slice(0, SESSION_SEARCH_MAX_QUERY_CHARS)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 16)
    .map((t) => `"${t}"*`);
}
