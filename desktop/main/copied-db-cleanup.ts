/**
 * ATO-418 — the importer's clean-up, for a database the merge copies as is.
 *
 * When the shared directory has no sessions.sqlite / tasks.sqlite yet, the
 * merge (state-migrate.ts) copies the old desktop's file whole with
 * `VACUUM INTO` instead of running the agent's importer. The importer never
 * lets a row arrive still "live": its `SessionStore.insertMissing` ends a
 * session whose status was live as an interrupted turn and writes no turn
 * owner, and `TaskStore.insertMissing` puts a `running` task back to
 * `pending` with no start and no run owner (src/session/session-store.ts
 * endLiveTurn, src/tasks/task-store.ts unclaimed). The process that ran
 * them is gone, so without the same step a copied chat would show
 * "running" for ever and a copied task would stay claimed.
 *
 * The desktop cannot import src/, so this is the same rule in SQL, run on
 * the private copy before it is renamed into place. The values below are
 * the agent's own and must stay in step with it:
 *   - LIVE_SESSION_STATUSES (src/session/session-retention.ts);
 *   - INTERRUPTED_TURN_ENDING (src/session/session-store.ts): status
 *     `cancelled`, and the sentence as `lastError`, set in the payload JSON
 *     as well as the status column, as the agent's END_TURN_SQL does;
 *   - TASK_OWNER_GONE_ERROR and the `transport` category
 *     (src/tasks/task-store.ts), only where the row has no error of its own.
 * `updated_at` is kept, as the importer keeps it. A table or column an older
 * desktop's database does not have is skipped.
 */

export const LIVE_SESSION_STATUSES = ["running", "awaiting_approval", "awaiting_llm"] as const;
export const INTERRUPTED_TURN_STATUS = "cancelled";
export const INTERRUPTED_TURN_ERROR = "turn interrupted: the agent stopped before it finished";
export const TASK_OWNER_GONE_ERROR = "interrupted: the agent running it stopped";

type Stmt = { run(...params: unknown[]): { changes: number | bigint }; all(...params: unknown[]): unknown[] };
type Db = { prepare(sql: string): Stmt; exec(sql: string): void; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean; timeout?: number }) => Db };

function nodeSqlite(): NodeSqlite {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:sqlite") as NodeSqlite;
}

function columnsOf(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((r) => r.name).filter((n): n is string => typeof n === "string"));
}

/**
 * Clean one copied database in place. `name` is its file name; only
 * sessions.sqlite and tasks.sqlite carry live rows, anything else is left
 * alone. Returns how many rows were ended or put back. Throws when the file
 * cannot be opened or written; the caller says so and keeps the copy.
 */
export function cleanCopiedDatabase(file: string, name: string): number {
  if (name !== "sessions.sqlite" && name !== "tasks.sqlite") return 0;
  const db = new (nodeSqlite().DatabaseSync)(file, { timeout: 5000 });
  try {
    return name === "sessions.sqlite" ? endLiveSessions(db) : unclaimRunningTasks(db);
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

function endLiveSessions(db: Db): number {
  const cols = columnsOf(db, "sessions");
  if (!cols.has("status")) return 0;
  const live = LIVE_SESSION_STATUSES.map((s) => `'${s}'`).join(", ");
  db.exec("BEGIN IMMEDIATE");
  try {
    const payload = cols.has("payload")
      ? `, payload = CASE WHEN json_valid(payload)
                         THEN json_set(payload, '$.status', ?, '$.lastError', ?)
                         ELSE payload END`
      : "";
    const params = cols.has("payload")
      ? [INTERRUPTED_TURN_STATUS, INTERRUPTED_TURN_STATUS, INTERRUPTED_TURN_ERROR]
      : [INTERRUPTED_TURN_STATUS];
    const ended = Number(db.prepare(`UPDATE sessions SET status = ?${payload} WHERE status IN (${live})`).run(...params).changes);
    // The importer writes no turn owner on any copied row.
    if (cols.has("turn_owner")) db.prepare("UPDATE sessions SET turn_owner = NULL WHERE turn_owner IS NOT NULL").run();
    db.exec("COMMIT");
    return ended;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    throw err;
  }
}

function unclaimRunningTasks(db: Db): number {
  const cols = columnsOf(db, "tasks");
  if (!cols.has("status")) return 0;
  const sets = ["status = 'pending'"];
  const params: unknown[] = [];
  if (cols.has("started_at")) sets.push("started_at = NULL");
  if (cols.has("last_error")) { sets.push("last_error = COALESCE(last_error, ?)"); params.push(TASK_OWNER_GONE_ERROR); }
  if (cols.has("last_error_cat")) sets.push("last_error_cat = COALESCE(last_error_cat, 'transport')");
  db.exec("BEGIN IMMEDIATE");
  try {
    const requeued = Number(db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE status = 'running'`).run(...params).changes);
    // The importer writes no run owner on any copied row.
    if (cols.has("run_owner")) db.prepare("UPDATE tasks SET run_owner = NULL WHERE run_owner IS NOT NULL").run();
    db.exec("COMMIT");
    return requeued;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    throw err;
  }
}
