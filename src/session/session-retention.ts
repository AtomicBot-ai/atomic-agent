import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import type Database from "better-sqlite3";
import { traceFilePath } from "../tracing/trace/trace-sink.js";
import type { SessionStatus } from "./session-state.js";
import { readTaskPinnedSessionIds } from "./task-pinned-sessions.js";

/**
 * One bounded retention pass over the `sessions` table, run at startup.
 *
 * Nothing in the runtime ever shrank this table: `SessionStore.delete`
 * is one row at a time behind an operator's confirmation, and the only
 * bulk wipe that ships is `atag uninstall`, which destroys the whole
 * state dir. An install left running for a year therefore carries every
 * session it ever had, plus one `traces/<id>.ndjson` per session. Opt-in
 * (`sessions.retention.enabled`); see §"Session retention" in AGENTS.md.
 */

/** Days → ms, so the config can talk in days and the SQL in epoch ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per statement, so that no single write transaction covers
 * the whole table: an operator with tens of thousands of sessions would
 * otherwise hand the boot path one enormous DELETE holding the write lock
 * while `SessionStore` is already trying to save the session being started.
 */
const BATCH_SIZE = 500;

/**
 * How long a row is safe from the orphan and unreadable rules. Both
 * describe a session by what its payload does *not* contain, and a
 * session created seconds ago at boot looks exactly like a `+ new` that
 * was never used. A day is the difference between "never used" and "not
 * used yet".
 */
const GRACE_MS = 24 * 60 * 60 * 1000;

/** Below this a vacuum rewrites a file too small for the saving to matter. */
const VACUUM_MIN_PAGES = 512;
/** Free space worth reclaiming, as a share of the file. */
const VACUUM_FREELIST_RATIO = 0.1;

/**
 * Statuses a prune never touches: a turn is running on that row right
 * now, or it is parked waiting for a human or for the model. Deleting one
 * would pull the row out from under a live `executeTurn`. Note what is
 * *not* here: a finished chat is set back to `pending` (`agent-loop.ts`,
 * the `reason === "reply"` branch) and only an explicit `finish` writes
 * `completed`, so status says nothing about whether a session is done —
 * which is why age, not status, is the rule.
 */
export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = [
  "running",
  "awaiting_approval",
  "awaiting_llm",
];

/** Temp table holding the ids this pass must not touch. */
const KEEP_TABLE = "retention_keep";

/**
 * Appended to every rule below, so an exemption cannot be forgotten at
 * one call site. The keep list is a table because it is unbounded — one
 * row per task with a session — and because it has to live inside the
 * predicate: filtering the exempt ids out in JS afterwards would let a
 * batch of nothing but exempt rows come back unchanged for ever.
 */
const DELETABLE = `status NOT IN (${LIVE_SESSION_STATUSES.map(
  (status) => `'${status}'`,
).join(", ")})
   AND id NOT IN (SELECT id FROM ${KEEP_TABLE})`;

export interface PruneSessionsOptions {
  /**
   * The store's own live handle (`getDatabaseHandleForRetention`), not a
   * second connection: that would queue behind the writer this pass runs
   * alongside.
   */
  db: Database.Database;
  /** Prune rows whose `updated_at` is older than this; `null` = no age rule. */
  maxAgeDays: number | null;
  /** Keep at most this many rows, oldest first; `null` = no cap. */
  maxRows: number | null;
  /** Wall clock, injected so tests are not time-dependent. */
  now?: number;
  /** `<stateDir>/traces`. Omitted leaves trace files alone. */
  tracesDir?: string | null;
  /** `<stateDir>/tasks.sqlite`. Omitted skips the task-pinned check. */
  tasksDbFile?: string | null;
  /** Ids the caller knows are in use, whatever the table says. */
  keepSessionIds?: Iterable<string>;
}

export interface PruneSessionsResult {
  /**
   * Rows removed in total. The two counters below are what *their* rule
   * removed, so they do not add up to this: an empty session that is also
   * 100 days old is taken by the age rule and counted only here.
   */
  deleted: number;
  /** Rows the `turnCount = 0` rule removed. */
  orphans: number;
  /** Rows the `NOT json_valid(payload)` rule removed. */
  unreadable: number;
  /** Trace files removed alongside those rows. */
  tracesRemoved: number;
  /** Whether the file was compacted afterwards. */
  vacuumed: boolean;
}

/**
 * Apply the retention rules, oldest-first, in bounded batches. Returns
 * what it removed; an all-zero result means there was nothing to do.
 */
export function pruneSessions(
  options: PruneSessionsOptions,
): PruneSessionsResult {
  const { db } = options;
  const now = options.now ?? Date.now();
  const tracesDir = options.tracesDir ?? null;
  const result: PruneSessionsResult = {
    deleted: 0,
    orphans: 0,
    unreadable: 0,
    tracesRemoved: 0,
    vacuumed: false,
  };
  const keep = new Set(options.keepSessionIds ?? []);
  for (const id of readTaskPinnedSessionIds(options.tasksDbFile)) keep.add(id);

  try {
    fillKeepTable(db, keep);
    const sweep = (where: string, ...params: number[]): number =>
      deleteInBatches(db, where, params, tracesDir, result);

    if (options.maxAgeDays !== null) {
      sweep(
        `updated_at < ? AND ${DELETABLE}`,
        now - options.maxAgeDays * DAY_MS,
      );
    }
    // `json_valid` first and `AND` short-circuiting is what keeps
    // `json_extract` off a payload it would raise on — the same guard
    // `LIST_SUMMARIES_SQL` relies on.
    result.orphans = sweep(
      `updated_at < ?
         AND json_valid(payload)
         AND json_extract(payload, '$.turnCount') = 0
         AND ${DELETABLE}`,
      now - GRACE_MS,
    );
    result.unreadable = sweep(
      `updated_at < ? AND NOT json_valid(payload) AND ${DELETABLE}`,
      now - GRACE_MS,
    );
    if (options.maxRows !== null) {
      enforceRowCap(db, options.maxRows, tracesDir, result);
    }
  } finally {
    dropKeepTable(db);
  }

  result.vacuumed = result.deleted > 0 && vacuumIfWorthIt(db);
  return result;
}

/**
 * Delete every row matching `where`, `BATCH_SIZE` at a time, and remove
 * the trace file of each one. Returns what this rule took. Selecting the
 * ids first and deleting by primary key — rather than one
 * `DELETE … WHERE id IN (SELECT … LIMIT n)` — evaluates the predicate
 * once per batch instead of twice and hands back the exact ids the trace
 * sweep needs; the loop ends because every selected id is then gone.
 */
function deleteInBatches(
  db: Database.Database,
  where: string,
  params: readonly number[],
  tracesDir: string | null,
  result: PruneSessionsResult,
): number {
  const select = db.prepare(
    `SELECT id FROM sessions WHERE ${where} ORDER BY updated_at ASC LIMIT ?`,
  );
  let removed = 0;
  for (;;) {
    const ids = (select.all(...params, BATCH_SIZE) as { id: string }[]).map(
      (row) => row.id,
    );
    if (ids.length === 0) return removed;
    removeIds(db, ids, tracesDir, result);
    removed += ids.length;
  }
}

/**
 * Bring the table down to `maxRows` by dropping the oldest deletable
 * rows. Counted against the whole table, exempt rows included: the cap
 * is a statement about the file, and a run of live sessions must not
 * make it delete more of the operator's history than they asked for.
 */
function enforceRowCap(
  db: Database.Database,
  maxRows: number,
  tracesDir: string | null,
  result: PruneSessionsResult,
): void {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM sessions`);
  const select = db.prepare(
    `SELECT id FROM sessions WHERE ${DELETABLE} ORDER BY updated_at ASC LIMIT ?`,
  );
  for (;;) {
    const overflow = (count.get() as { n: number }).n - maxRows;
    if (overflow <= 0) return;
    const ids = (
      select.all(Math.min(overflow, BATCH_SIZE)) as { id: string }[]
    ).map((row) => row.id);
    // Everything left over the cap is exempt. Stopping is the right
    // answer: the alternative is deleting a running session.
    if (ids.length === 0) return;
    removeIds(db, ids, tracesDir, result);
  }
}

/** One batch: the rows, then their trace files. */
function removeIds(
  db: Database.Database,
  ids: readonly string[],
  tracesDir: string | null,
  result: PruneSessionsResult,
): void {
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  result.deleted += ids.length;
  if (tracesDir === null) return;
  for (const id of ids) {
    if (removeTraceFile(tracesDir, id)) result.tracesRemoved += 1;
  }
}

/**
 * Best-effort: a session whose tracing was off has no file, and a trace
 * that cannot be removed is not a reason to fail a boot-time prune.
 */
function removeTraceFile(tracesDir: string, sessionId: string): boolean {
  const path = traceFilePath(tracesDir, sessionId);
  // Ids come out of the table, and a `../` in one would put this `rm`
  // outside the traces directory. Nothing writes such an id today; this is
  // what keeps that from mattering if something ever does.
  if (!resolve(path).startsWith(`${resolve(tracesDir)}${sep}`)) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function fillKeepTable(db: Database.Database, ids: ReadonlySet<string>): void {
  dropKeepTable(db);
  db.exec(`CREATE TEMP TABLE ${KEEP_TABLE} (id TEXT PRIMARY KEY)`);
  if (ids.size === 0) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${KEEP_TABLE} (id) VALUES (?)`,
  );
  for (const id of ids) insert.run(id);
}

/** The table lives on the connection, which outlives this pass. */
function dropKeepTable(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${KEEP_TABLE}`);
}

/**
 * Compact the file, but only when the delete actually freed something
 * worth rewriting for. A `VACUUM` copies the whole database, so running
 * one on every boot would be a fixed startup cost paid for nothing.
 */
function vacuumIfWorthIt(db: Database.Database): boolean {
  const pages = pragmaCount(db, "page_count");
  if (pages < VACUUM_MIN_PAGES) return false;
  if (pragmaCount(db, "freelist_count") <= pages * VACUUM_FREELIST_RATIO) {
    return false;
  }
  try {
    db.exec("VACUUM");
    return true;
  } catch {
    // Blocked by another connection: housekeeping deferred to the next
    // boot, not a failed prune.
    return false;
  }
}

function pragmaCount(db: Database.Database, name: string): number {
  const value = db.pragma(name, { simple: true });
  return typeof value === "number" ? value : 0;
}
