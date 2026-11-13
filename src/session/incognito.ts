import type Database from "better-sqlite3";

import {
  isTurnOwnerGone,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "./turn-owner.js";

/**
 * An incognito chat (ATO-586): a session that leaves nothing behind.
 *
 * Chosen before the first message (`--incognito`, `/incognito`, the HTTP
 * `incognito` field on a new chat) and fixed for the session's life:
 *
 *  - no memory is written from it — no reflection (profile facts, notes,
 *    links, votes, evolves), no lesson counters, and the
 *    `memory.profile.set` / `memory.notes.store` tools refuse — so no
 *    embedding is made for it either (embeddings exist only for stored
 *    notes);
 *  - it is left out of every session list and search (the rail, `GET
 *    /api/sessions`, recent folders, the name check's "did the user ever
 *    write this name" walk);
 *  - its row, its archived turns and its trace file are deleted when it is
 *    closed, and on the next start when the process that owned it is gone
 *    (a crash, a kill) — see `SessionStore.sweepOrphanIncognito`.
 *
 * Reading existing memory is left on: the chat still knows the user, it
 * just does not learn from this conversation.
 *
 * The row is still written while the chat is open: every runtime path
 * (turn marks, checkpoints, the HTTP routes, the desktop) loads a session
 * by id between turns, and keeping an incognito chat out of the table
 * would mean a second store for all of them.
 */
export interface IncognitoMark {
  /** When the chat was opened, ms since the epoch. */
  readonly since: number;
  /**
   * The process that opened it, as `serializeTurnOwner` writes a turn
   * mark. The next start deletes the chat once this process is gone.
   */
  readonly owner: string;
}

/** Whether `state` is an incognito chat. */
export function isIncognitoSession(
  state: { readonly incognito?: IncognitoMark | undefined } | null | undefined,
): boolean {
  return typeof state?.incognito === "object" && state.incognito !== null;
}

/** The mark a new incognito chat carries, owned by `probe`'s process. */
export function newIncognitoMark(
  probe: TurnOwnerProbe,
  at: number,
  db?: string,
): IncognitoMark {
  return { since: at, owner: serializeTurnOwner(turnOwnerFor(probe, at, db)) };
}

const SELECT_INCOGNITO_SQL = `
SELECT id, json_extract(payload, '$.incognito.owner') AS owner
  FROM sessions
 WHERE json_valid(payload)
   AND json_type(payload, '$.incognito') = 'object'`;

const IS_INCOGNITO_SQL = `
SELECT 1 AS hit
  FROM sessions
 WHERE id = ?
   AND json_valid(payload)
   AND json_type(payload, '$.incognito') = 'object'`;

/** Whether the stored row `id` is an incognito chat. */
export function storedSessionIsIncognito(
  db: Database.Database,
  id: string,
): boolean {
  return db.prepare(IS_INCOGNITO_SQL).get(id) !== undefined;
}

/**
 * The incognito chats whose owning process is gone. Meant for boot,
 * before this process opens a chat of its own (`isTurnOwnerGone` reads a
 * mark carrying this process's pid as an earlier process's). A chat
 * another live window or `serve` still holds is left alone.
 */
export function orphanIncognitoSessionIds(
  db: Database.Database,
  probe: TurnOwnerProbe,
  dbIdentity?: string,
): string[] {
  const rows = db.prepare(SELECT_INCOGNITO_SQL).all() as Array<{
    id: string;
    owner: unknown;
  }>;
  return rows
    .filter((row) =>
      isTurnOwnerGone(
        typeof row.owner === "string" ? row.owner : null,
        probe,
        dbIdentity,
      ),
    )
    .map((row) => row.id);
}
