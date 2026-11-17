import type Database from "better-sqlite3";

/**
 * ATO-1059. A journal of the changes that lose something in memory: a
 * note's text replaced, a note deleted, a profile fact deleted. Each row
 * keeps the record as it was before, so one wrong change can be undone
 * without wiping the rest. Profile edits need no row here: every
 * `ProfileStore.set` already keeps the old version (`history(key)`).
 *
 * The table is created in place (`CREATE TABLE IF NOT EXISTS`), not
 * behind a `MEMORY_SCHEMA_VERSION` bump: a bump would stop an older
 * desktop or terminal build sharing the state dir from opening
 * memory.sqlite at all (see `NAME_GROUNDING_COLUMNS` in memory-schema.ts).
 * Older builds never touch the table, so their changes are simply not
 * journaled.
 *
 * Not journaled: overflow eviction, dedup merges and consolidation
 * archives. Those are the store's own housekeeping, run in bulk.
 *
 * This file must not import `memory-store.ts` or `profile-store.ts`:
 * both stores import it.
 */

export type MemoryChangeKind = "note" | "profile";
export type MemoryChangeOp = "update" | "remove";
/** Who asked for the change: the person (HTTP routes) or the agent (tools, reflection). */
export type MemoryChangeActor = "user" | "agent";

/** The record before the change, as the store held it. */
export interface NoteSnapshot {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: string;
  sessionId: string | null;
  workingDir: string | null;
  tags: string[];
}

export interface ProfileSnapshot {
  key: string;
  value: string;
  pinned: boolean;
  keywords: string[];
}

export interface MemoryChange {
  id: number;
  kind: MemoryChangeKind;
  /** The note id (as text) or the profile key. */
  target: string;
  op: MemoryChangeOp;
  by: MemoryChangeActor;
  at: number;
  before: NoteSnapshot | ProfileSnapshot;
  /** The new text for a note `update`; `null` for a removal. */
  after: string | null;
  /** When this change was undone; `null` while it stands. */
  restoredAt: number | null;
}

export interface MemoryChangeInput {
  kind: MemoryChangeKind;
  target: string;
  op: MemoryChangeOp;
  by: MemoryChangeActor;
  before: NoteSnapshot | ProfileSnapshot;
  after?: string | null;
}

/** Rows older than this are pruned when a store opens. */
export const MEMORY_CHANGE_LOG_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MEMORY_CHANGE_LOG_LIST_MAX = 200;

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  op          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  before      TEXT NOT NULL,
  after       TEXT,
  restored_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_change_log_at ON memory_change_log(at DESC);
`;

interface ChangeRow {
  id: number;
  kind: string;
  target: string;
  op: string;
  actor: string;
  at: number;
  before: string;
  after: string | null;
  restored_at: number | null;
}

function rowToChange(row: ChangeRow): MemoryChange {
  return {
    id: row.id,
    kind: row.kind === "profile" ? "profile" : "note",
    target: row.target,
    op: row.op === "update" ? "update" : "remove",
    by: row.actor === "user" ? "user" : "agent",
    at: row.at,
    before: JSON.parse(row.before) as NoteSnapshot | ProfileSnapshot,
    after: row.after,
    restoredAt: row.restored_at,
  };
}

export class MemoryChangeLog {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly markRestoredStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    now: number = Date.now(),
  ) {
    db.exec(TABLE_SQL);
    db.prepare(`DELETE FROM memory_change_log WHERE at < ?`).run(
      now - MEMORY_CHANGE_LOG_MAX_AGE_MS,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO memory_change_log (kind, target, op, actor, at, before, after, restored_at)
       VALUES (@kind, @target, @op, @actor, @at, @before, @after, NULL)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM memory_change_log WHERE id = ?`);
    this.markRestoredStmt = db.prepare(
      `UPDATE memory_change_log SET restored_at = ? WHERE id = ? AND restored_at IS NULL`,
    );
  }

  record(input: MemoryChangeInput, now: number = Date.now()): number {
    const result = this.insertStmt.run({
      kind: input.kind,
      target: input.target,
      op: input.op,
      actor: input.by,
      at: now,
      before: JSON.stringify(input.before),
      after: input.after ?? null,
    }) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  /** Newest first. */
  list(opts: { limit?: number; kind?: MemoryChangeKind; target?: string } = {}): MemoryChange[] {
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), MEMORY_CHANGE_LOG_LIST_MAX);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.target !== undefined) {
      where.push("target = ?");
      params.push(opts.target);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM memory_change_log ${clause} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...params) as ChangeRow[];
    return rows.map(rowToChange);
  }

  get(id: number): MemoryChange | null {
    const row = this.getStmt.get(id) as ChangeRow | undefined;
    return row ? rowToChange(row) : null;
  }

  /** `false` when the change was already undone (or is unknown). */
  markRestored(id: number, now: number = Date.now()): boolean {
    const result = this.markRestoredStmt.run(now, id) as { changes: number };
    return result.changes > 0;
  }
}
