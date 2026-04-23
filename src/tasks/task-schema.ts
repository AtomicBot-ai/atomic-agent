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
export const TASK_SCHEMA_VERSION = 1 as const;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
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
  if (current === TASK_SCHEMA_VERSION) return;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(TASK_SCHEMA_VERSION));
}
