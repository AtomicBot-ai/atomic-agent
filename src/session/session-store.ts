import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/index.js";
import { stripEphemeral, type SessionState } from "./session-state.js";

function normalizeSessionState(raw: unknown): SessionState {
  const s = raw as SessionState;
  return {
    ...s,
    loadedTools: s.loadedTools ?? [],
    loadedSkills: s.loadedSkills ?? [],
  };
}

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

export interface SessionStoreOptions {
  dbFile?: string;
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
  private readonly deleteStmt: Database.Statement;

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
    return normalizeSessionState(JSON.parse(row.payload));
  }

  listByWorkingDir(workingDir: string, limit = 25): SessionState[] {
    const rows = this.listByWorkingDirStmt.all(workingDir, limit) as Array<{
      payload: string;
    }>;
    return rows.map((row) => normalizeSessionState(JSON.parse(row.payload)));
  }

  /**
   * Return the most recently updated sessions across all working dirs.
   * Used by the TUI session picker so the operator can jump between
   * ongoing threads from any project root.
   */
  listRecent(limit = 25): SessionState[] {
    const rows = this.listRecentStmt.all(limit) as Array<{ payload: string }>;
    return rows.map((row) => normalizeSessionState(JSON.parse(row.payload)));
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  close(): void {
    this.db.close();
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
