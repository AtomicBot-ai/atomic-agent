import { existsSync, readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

/**
 * What outside `sessions.sqlite` points at a session by id, and would be
 * left holding a dead pointer if retention took the row.
 *
 * Both sources live in the state dir and neither can have a foreign key
 * into the sessions table — one is a separate SQLite file (SQLite has no
 * cross-file FKs), the other is a JSON file. So the only thing that keeps
 * a prune honest is reading them, and the cost of not reading them is a
 * scheduled job or a webhook binding that silently stops working.
 *
 * Every reader here is read-only and forgiving: a missing file, a missing
 * table, a corrupt payload or a handle that will not open all read as "no
 * pins" rather than failing. The surfaces they describe are optional
 * (`tasks.enabled`, a webhook the operator may never have configured) and
 * the runtime has to boot either way.
 *
 * What is deliberately *not* here: the Telegram and Discord per-chat
 * session pointers. Those two paths already treat a pointer to a missing
 * session as something to heal rather than an error — see
 * `acquireOrCreateSession` in both inbound handlers, which logs
 * `pointer references missing session, recreating`, releases the approval
 * binding and mints a fresh session with the same chat metadata.
 */

/** Everything that pins a session, from every source, deduped. */
export function readSessionPins(sources: {
  tasksDbFile?: string | null;
  webhookSessionsFile?: string | null;
}): string[] {
  return [
    ...new Set([
      ...readTaskPinnedSessionIds(sources.tasksDbFile),
      ...readWebhookPinnedSessionIds(sources.webhookSessionsFile),
    ]),
  ];
}

/**
 * Sessions a scheduled task points at, from `tasks.sqlite`.
 *
 * `TaskRunner` finds out that a session is gone by marking the task
 * `blocked` with `session_not_found`, which is a scheduled job that
 * stops happening without telling anyone.
 */
export function readTaskPinnedSessionIds(
  tasksDbFile: string | null | undefined,
): string[] {
  if (!tasksDbFile || !existsSync(tasksDbFile)) return [];
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(tasksDbFile, {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare(
        `SELECT DISTINCT session_id AS id FROM tasks WHERE session_id IS NOT NULL`,
      )
      .all() as { id: unknown }[];
    return onlyIds(rows.map((row) => row.id));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do with a handle that will not close.
    }
  }
}

/**
 * Sessions a `persistent` webhook binding reuses, from
 * `webhook-sessions.json` — a flat `{ <webhookName>: <sessionId> }` map
 * (see `WebhookSessionStore`).
 *
 * `resolveWebhookSessionId` hands the stored id straight back on every
 * hit and only creates a session when there is no entry at all, so a
 * pruned row does not heal itself: the binding keeps its dead id and
 * every later hit materialises a task that blocks with
 * `session_not_found`.
 */
export function readWebhookPinnedSessionIds(
  webhookSessionsFile: string | null | undefined,
): string[] {
  if (!webhookSessionsFile || !existsSync(webhookSessionsFile)) return [];
  try {
    const parsed = JSON.parse(
      readFileSync(webhookSessionsFile, "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return onlyIds(Object.values(parsed as Record<string, unknown>));
  } catch {
    // The same reading `WebhookSessionStore` gives a corrupt file: an
    // empty map. It pins nothing, and the store will overwrite it.
    return [];
  }
}

/** Non-empty strings only — the file is hand-editable. */
function onlyIds(values: readonly unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
