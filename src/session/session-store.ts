import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/index.js";
import { stripEphemeral, type SessionState } from "./session-state.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import type { SessionSummary } from "./session-summary.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  working_dir  TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_working_dir ON sessions(working_dir);
`;

/**
 * One row per readable session, newest first, with the fields a list
 * renders lifted out of the JSON in SQL — no LIMIT, because the rail
 * windows its own rows, and no JSON.parse, because one malformed payload
 * must not take every other row down with it. The `WHERE` keeps the
 * `json_each` subquery off payloads it cannot walk, and the subquery's
 * `t.type = 'object'` keeps `json_extract` off array elements that are
 * not JSON objects — a bare string element is not JSON text and would
 * raise "malformed JSON". `AND` short-circuits, so the guard holds.
 */
const LIST_SUMMARIES_SQL = `
SELECT id,
       working_dir AS workingDir,
       status,
       created_at AS createdAt,
       updated_at AS updatedAt,
       json_extract(payload, '$.turnCount') AS turnCount,
       json_extract(payload, '$.stepCount') AS stepCount,
       (SELECT json_extract(t.value, '$.text')
          FROM json_each(payload, '$.turns') AS t
         WHERE t.type = 'object'
           AND json_extract(t.value, '$.kind') = 'user'
         LIMIT 1) AS firstPrompt,
       json_extract(payload, '$.metadata.importedFrom') AS importedFrom
  FROM sessions
 WHERE json_valid(payload) AND json_type(payload, '$.turns') = 'array'
 ORDER BY updated_at DESC`;

const COUNT_UNREADABLE_SQL = `SELECT COUNT(*) AS n FROM sessions WHERE NOT json_valid(payload)`;

interface SummaryRow {
  id: string;
  workingDir: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  turnCount: unknown;
  stepCount: unknown;
  firstPrompt: unknown;
  importedFrom: unknown;
}

function toSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    workingDir: row.workingDir,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    turnCount: toCount(row.turnCount),
    stepCount: toCount(row.stepCount),
    firstPrompt: toText(row.firstPrompt),
    importedFrom: toText(row.importedFrom),
  };
}

/** `json_extract` hands back whatever the JSON held; a count is a number or 0. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `NULL` stays null; a non-string JSON value is still shown, as text. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

export interface SessionStoreOptions {
  dbFile?: string;
}

/** Narrow projection returned by `listRecentWorkingDirs`. */
export interface RecentWorkingDirRow {
  workingDir: string;
  updatedAt: number;
}

/**
 * Durable session persistence. We serialise the whole SessionState as JSON
 * because it is small (<10 KB) and we optimise for developer iteration
 * over schema stability. A columnar migration can come later.
 */
export class SessionStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly listByWorkingDirStmt: Database.Statement;
  private readonly listRecentStmt: Database.Statement;
  private readonly listRecentDirsStmt: Database.Statement;
  private readonly listSummariesStmt: Database.Statement;
  private readonly countUnreadableStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  /**
   * How many rows `load` / `listRecent` / `listByWorkingDir` have skipped
   * because their payload would not parse. Counts every skip, so the
   * same bad row read twice counts twice; `countUnreadable` is the
   * number of such rows in the table.
   */
  private unreadableSkips = 0;

  constructor(options: SessionStoreOptions = {}) {
    const config = getConfig();
    const file = options.dbFile ?? config.paths.sessionsDbFile;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseCtor(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
       VALUES (@id, @working_dir, @status, @payload, @created_at, @updated_at)`,
    );
    this.updateStmt = this.db.prepare(
      `UPDATE sessions
       SET working_dir = @working_dir,
           status = @status,
           payload = @payload,
           updated_at = @updated_at
       WHERE id = @id`,
    );
    this.selectStmt = this.db.prepare(`SELECT payload FROM sessions WHERE id = ?`);
    this.listByWorkingDirStmt = this.db.prepare(
      `SELECT payload FROM sessions WHERE working_dir = ? ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentStmt = this.db.prepare(
      `SELECT payload FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentDirsStmt = this.db.prepare(
      `SELECT working_dir AS workingDir, updated_at AS updatedAt
       FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listSummariesStmt = this.db.prepare(LIST_SUMMARIES_SQL);
    this.countUnreadableStmt = this.db.prepare(COUNT_UNREADABLE_SQL);
    this.deleteStmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
  }

  save(state: SessionState): void {
    const row = this.serialize(state);
    const existing = this.selectStmt.get(state.id);
    if (existing) {
      this.updateStmt.run(row);
    } else {
      this.insertStmt.run(row);
    }
  }

  load(id: string): SessionState | null {
    const row = this.selectStmt.get(id) as { payload: string } | undefined;
    if (!row) return null;
    return this.readPayload(row);
  }

  listByWorkingDir(workingDir: string, limit = 25): SessionState[] {
    const rows = this.listByWorkingDirStmt.all(workingDir, limit) as Array<{
      payload: string;
    }>;
    return this.readPayloads(rows);
  }

  /**
   * Return the most recently updated sessions across all working dirs.
   * Used by the TUI session picker so the operator can jump between
   * ongoing threads from any project root.
   */
  listRecent(limit = 25): SessionState[] {
    const rows = this.listRecentStmt.all(limit) as Array<{ payload: string }>;
    return this.readPayloads(rows);
  }

  /**
   * Every readable session as a list row, newest first, projected in
   * SQL (see `LIST_SUMMARIES_SQL`). Rows whose payload is not valid JSON
   * or whose `turns` is not an array are left out; `countUnreadable`
   * says how many of the former there are.
   */
  listSummaries(): SessionSummary[] {
    const rows = this.listSummariesStmt.all() as SummaryRow[];
    return rows.map(toSummary);
  }

  /** Rows whose payload is not valid JSON — the ones every reader skips. */
  countUnreadable(): number {
    const row = this.countUnreadableStmt.get() as { n: number };
    return row.n;
  }

  /** Skips recorded by `load` / `listRecent` / `listByWorkingDir` so far. */
  get unreadableRowsSkipped(): number {
    return this.unreadableSkips;
  }

  /**
   * Column-only projection of the most recently updated sessions.
   * `os.fs.locate_project` calls this on demand (potentially inside a
   * pure_read fan-out batch), so it must not pay `listRecent`'s
   * JSON.parse of every full session payload — `working_dir` and
   * `updated_at` already live as columns.
   */
  listRecentWorkingDirs(limit = 25): RecentWorkingDirRow[] {
    return this.listRecentDirsStmt.all(limit) as RecentWorkingDirRow[];
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Parse one stored payload, or `null` when it will not parse. A row
   * that is not JSON — a truncated write, a hand edit — used to throw
   * out of every list and empty the rail; now it is skipped and counted.
   */
  private readPayload(row: { payload: string }): SessionState | null {
    try {
      return normalizeSessionState(JSON.parse(row.payload));
    } catch {
      this.unreadableSkips += 1;
      return null;
    }
  }

  private readPayloads(rows: Array<{ payload: string }>): SessionState[] {
    const states: SessionState[] = [];
    for (const row of rows) {
      const state = this.readPayload(row);
      if (state) states.push(state);
    }
    return states;
  }

  private serialize(state: SessionState): Record<string, unknown> {
    const persistable = stripEphemeral(state);
    return {
      id: persistable.id,
      working_dir: persistable.workingDir,
      status: persistable.status,
      payload: JSON.stringify(persistable),
      created_at: persistable.createdAt,
      updated_at: persistable.updatedAt,
    };
  }
}
