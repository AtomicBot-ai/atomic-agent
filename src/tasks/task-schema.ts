/**
 * SQLite schema for the durable task queue. Lives in its own file
 * (`<stateDir>/tasks.sqlite`) — separate from `sessions.sqlite` and
 * `memory.sqlite` — because tasks have a different lifecycle than
 * sessions and a different access pattern than the memory fabric.
 *
 * Cross-file FKs are not supported in SQLite; `session_id` validity is
 * checked at runtime by `TaskRunner` (a missing session moves the task
 * to `blocked` with a stable reason).
 *
 * Schema evolution: bump `TASK_SCHEMA_VERSION` and extend
 * `applyMigrations` with a new step. The `schema_meta` table records
 * the version actually present on disk so upgrades are idempotent.
 */
export const TASK_SCHEMA_VERSION = 3 as const;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  session_id      TEXT,
  user_message    TEXT NOT NULL,
  max_steps       INTEGER,
  status          TEXT NOT NULL,
  origin          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  last_error      TEXT,
  last_error_cat  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
  ON tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session
  ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pending_created
  ON tasks(status, created_at) WHERE status = 'pending';
`;

/**
 * v1 -> v2 migration: adds scheduling columns so the new `Scheduler`
 * can query due tasks through a dedicated index. The partial index
 * `idx_tasks_due` is the only path the scheduler uses to find work —
 * never a full table scan.
 *
 * `session_id` is also relaxed to nullable here because one-shot tasks
 * may be persisted without a session (the runner creates one lazily at
 * the first `runOne` attempt). SQLite cannot drop a NOT NULL constraint
 * via `ALTER TABLE`; existing rows are already non-null so we simply
 * rely on `IF NOT EXISTS` on the base schema (new installs get the
 * nullable column) and the absence of a runtime check that would reject
 * `null` — the runner is the sole writer of this column from v2 on.
 */
const V2_MIGRATION = `
ALTER TABLE tasks ADD COLUMN schedule_kind TEXT;
ALTER TABLE tasks ADD COLUMN schedule_value TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_for INTEGER;
ALTER TABLE tasks ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_scheduled_at INTEGER;
ALTER TABLE tasks ADD COLUMN trigger_source TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(status, scheduled_for) WHERE status = 'pending';
`;

/**
 * v2 -> v3 migration: adds the per-task `notify` opt-in so a scheduled
 * task can report its terminal outcome to a remote channel (Telegram
 * today). `NULL` (the default for every existing row) preserves the
 * pre-v3 behaviour: tasks finish silently. Values are validated
 * against `TASK_NOTIFY_TARGETS` at write time and clamped to `NULL`
 * on read, so no index is needed — the column is never queried by
 * itself.
 */
const V3_MIGRATION = `
ALTER TABLE tasks ADD COLUMN notify TEXT;
`;

export interface TaskDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export function applyMigrations(db: TaskDatabaseLike): void {
  db.exec(BASE_SCHEMA);
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  const current = row ? Number.parseInt(row.value, 10) : 0;
  if (current > TASK_SCHEMA_VERSION) {
    throw new Error(
      `tasks.sqlite schema version ${current} is newer than the supported ${TASK_SCHEMA_VERSION}; refusing to downgrade`,
    );
  }
  if (current < 2) {
    db.exec(V2_MIGRATION);
  }
  if (current < 3) {
    db.exec(V3_MIGRATION);
  }
  if (current === TASK_SCHEMA_VERSION) return;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(TASK_SCHEMA_VERSION));
}
