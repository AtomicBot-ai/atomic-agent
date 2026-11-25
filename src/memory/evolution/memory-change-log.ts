import type Database from "better-sqlite3";

/**
 * ATO-1059. A journal of the changes that lose something in memory: a
 * note's text replaced, a note deleted, a profile fact deleted. Each row
 * keeps the record as it was before, so one wrong change can be undone
 * without wiping the rest. Profile edits need no row here: every
 * `ProfileStore.set` already keeps the old version (`history(key)`).
 *
 * The store's own housekeeping is journaled too, as the agent's change:
 *  - `evict`: a note or an unpinned profile fact dropped over the cap;
 *  - `merge`: a new note folded into a near-duplicate one (dedup), the
 *    folded write kept in `before.absorbed`;
 *  - `archive`: a note hidden by consolidation into a lesson (`after`
 *    is the lesson id);
 *  - `create` / `deprecate`: a lesson or a procedure written or retired.
 *
 * The table is created in place (`CREATE TABLE IF NOT EXISTS`), not
 * behind a `MEMORY_SCHEMA_VERSION` bump: a bump would stop an older
 * desktop or terminal build sharing the state dir from opening
 * memory.sqlite at all (see `NAME_GROUNDING_COLUMNS` in memory-schema.ts).
 * Older builds never touch the table, so their changes are simply not
 * journaled.
 *
 * This file must not import `memory-store.ts` or `profile-store.ts`:
 * both stores import it.
 */

export type MemoryChangeKind = "note" | "profile" | "lesson" | "procedure";
export type MemoryChangeOp =
  | "update"
  | "remove"
  | "evict"
  | "merge"
  | "archive"
  | "create"
  | "deprecate";
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

/** The write a dedup merge folded into an existing note (op `merge`). */
export interface AbsorbedWrite {
  content: string;
  tags: string[];
  source: string;
  sessionId: string | null;
  workingDir: string | null;
  at: number;
}

/** For op `merge`: the existing note as it was, plus the write it absorbed. */
export interface MergeSnapshot extends NoteSnapshot {
  absorbed: AbsorbedWrite;
}

/** A lesson or a procedure as it was (ops `create` and `deprecate`). */
export interface LessonSnapshot {
  id: number;
  activation: string;
  principle: string;
  tags: string[];
  status: "active" | "deprecated";
}

export interface ProcedureSnapshot {
  id: number;
  activation: string;
  steps: unknown[];
  tags: string[];
  status: "active" | "deprecated";
}

export type MemoryChangeSnapshot =
  | NoteSnapshot
  | MergeSnapshot
  | ProfileSnapshot
  | LessonSnapshot
  | ProcedureSnapshot;

export interface MemoryChange {
  id: number;
  kind: MemoryChangeKind;
  /** The note, lesson or procedure id (as text) or the profile key. */
  target: string;
  op: MemoryChangeOp;
  by: MemoryChangeActor;
  at: number;
  before: MemoryChangeSnapshot;
  /**
   * The new text for a note `update`, the absorbed text for a `merge`,
   * the lesson id for an `archive`, the reason for a `deprecate`;
   * `null` otherwise.
   */
  after: string | null;
  /** When this change was undone; `null` while it stands. */
  restoredAt: number | null;
}

export interface MemoryChangeInput {
  kind: MemoryChangeKind;
  target: string;
  op: MemoryChangeOp;
  by: MemoryChangeActor;
  before: MemoryChangeSnapshot;
  after?: string | null;
}

/** Rows older than this are pruned when a store opens. */
export const MEMORY_CHANGE_LOG_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MEMORY_CHANGE_LOG_LIST_MAX = 200;

const KINDS: ReadonlySet<string> = new Set(["note", "profile", "lesson", "procedure"]);
const OPS: ReadonlySet<string> = new Set([
  "update",
  "remove",
  "evict",
  "merge",
  "archive",
  "create",
  "deprecate",
]);

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
    kind: (KINDS.has(row.kind) ? row.kind : "note") as MemoryChangeKind,
    target: row.target,
    op: (OPS.has(row.op) ? row.op : "remove") as MemoryChangeOp,
    by: row.actor === "user" ? "user" : "agent",
    at: row.at,
    before: JSON.parse(row.before) as MemoryChangeSnapshot,
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
