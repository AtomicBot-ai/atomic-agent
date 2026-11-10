import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ConversationTurn } from "./conversation-turn.js";
import type { SessionState } from "./session-state.js";

/**
 * Turns a context compaction already covers, kept out of the session row
 * (ATO-1271).
 *
 * Before this the row's payload carried the whole transcript, and every
 * write (each step's checkpoint, every turn's end) turned all of it into
 * one string with `JSON.stringify`, however much of it a compaction had
 * long since summarised. A session that runs for hours grows that string
 * without bound, and the peak memory of a write grows with it.
 *
 * Now the covered prefix lives here, one row per turn, written once when a
 * compaction first covers it and never again. The payload carries only
 * the turns after it, plus {@link ArchivedTurnsMarker} saying how many
 * rows go back in front. Readers of the store see no difference:
 * `SessionStore.load` hands back the whole transcript with the same
 * indices as before, so `coveredThrough`, `macroTurnStarts` and every
 * other absolute index keep their meaning.
 *
 * Archived turns are append-only. A write whose transcript no longer
 * starts with the archived rows (an older copy saved over a newer one,
 * history replaced by an import) drops the archive and stores the
 * transcript in full, so what a write saves is always what a load
 * returns.
 */

export const TURN_ARCHIVE_TABLE = "session_turn_archive";

const TURN_ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TURN_ARCHIVE_TABLE} (
  session_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  turn       TEXT NOT NULL,
  PRIMARY KEY (session_id, idx)
);
`;

/** Payload key that says how many archived turns go in front of `turns`. */
export const ARCHIVED_TURNS_KEY = "archivedTurns";

/**
 * Stored in the payload, never in a live `SessionState`. `firstUserText`
 * is the first user message of the archived prefix, for list rows that
 * read the opening prompt in SQL (`session-summary-page.ts`).
 */
export interface ArchivedTurnsMarker {
  count: number;
  firstUserText?: string;
}

export interface TurnArchiveStatements {
  last: Database.Statement;
  first: Database.Statement;
  insert: Database.Statement;
  clear: Database.Statement;
  read: Database.Statement;
}

/**
 * Create the archive table. Like the column helpers beside the store, a
 * failure (a file this process may only read, a write lock held past the
 * busy timeout) does not stop the store opening: it runs without an
 * archive and stores transcripts in full, as before. Returns why, or
 * `null`.
 */
export function ensureTurnArchiveTable(db: Database.Database): string | null {
  try {
    db.exec(TURN_ARCHIVE_SCHEMA);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Whether the archive table is there (a read; never takes the write lock). */
export function turnArchiveTableExists(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(TURN_ARCHIVE_TABLE) !== undefined
  );
}

export function prepareTurnArchiveStatements(
  db: Database.Database,
): TurnArchiveStatements {
  return {
    last: db.prepare(
      `SELECT idx, hash FROM ${TURN_ARCHIVE_TABLE}
       WHERE session_id = ? ORDER BY idx DESC LIMIT 1`,
    ),
    first: db.prepare(
      `SELECT hash FROM ${TURN_ARCHIVE_TABLE} WHERE session_id = ? AND idx = 0`,
    ),
    insert: db.prepare(
      `INSERT OR REPLACE INTO ${TURN_ARCHIVE_TABLE} (session_id, idx, hash, turn)
       VALUES (@session_id, @idx, @hash, @turn)`,
    ),
    clear: db.prepare(`DELETE FROM ${TURN_ARCHIVE_TABLE} WHERE session_id = ?`),
    read: db.prepare(
      `SELECT turn FROM ${TURN_ARCHIVE_TABLE}
       WHERE session_id = ? AND idx < ? ORDER BY idx ASC`,
    ),
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The digest the stored `hash` column holds for this turn. */
export function archivedTurnHash(turn: ConversationTurn): string {
  return hashText(JSON.stringify(turn));
}

/**
 * How many leading turns the compaction checkpoint covers, or 0. Not the
 * full `validSessionCompaction` check: the archive is storage and any
 * prefix is a correct split, so only the bounds matter here.
 */
export function coveredPrefixLength(state: SessionState): number {
  const covered = state.compaction?.coveredThrough;
  if (typeof covered !== "number" || !Number.isInteger(covered)) return 0;
  if (covered <= 0) return 0;
  return Math.min(covered, state.turns.length);
}

/**
 * Bring the archive in step with `state` and return how many leading
 * turns it now holds: the ones the payload leaves out. Must run inside
 * the same transaction as the payload write.
 */
export function syncTurnArchive(
  statements: TurnArchiveStatements,
  state: SessionState,
): number {
  const turns = state.turns;
  let stored = 0;
  const last = statements.last.get(state.id) as
    | { idx: number; hash: string }
    | undefined;
  if (last !== undefined) {
    stored = last.idx + 1;
    const first = statements.first.get(state.id) as
      | { hash: string }
      | undefined;
    const consistent =
      stored <= turns.length &&
      first !== undefined &&
      archivedTurnHash(turns[stored - 1]!) === last.hash &&
      archivedTurnHash(turns[0]!) === first.hash;
    if (!consistent) {
      statements.clear.run(state.id);
      stored = 0;
    }
  }
  const keep = Math.max(stored, coveredPrefixLength(state));
  for (let idx = stored; idx < keep; idx++) {
    const text = JSON.stringify(turns[idx]);
    statements.insert.run({
      session_id: state.id,
      idx,
      hash: hashText(text),
      turn: text,
    });
  }
  return keep;
}

/** The marker for an archive of the first `count` turns of `turns`. */
export function archivedTurnsMarker(
  turns: readonly ConversationTurn[],
  count: number,
): ArchivedTurnsMarker {
  for (let i = 0; i < count; i++) {
    const turn = turns[i];
    if (turn?.kind === "user" && typeof turn.text === "string") {
      return { count, firstUserText: turn.text };
    }
  }
  return { count };
}

/** The marker a parsed payload carries, or `null` when it has none. */
export function readArchivedTurnsMarker(
  raw: Record<string, unknown>,
): ArchivedTurnsMarker | null {
  const marker = raw[ARCHIVED_TURNS_KEY];
  if (typeof marker !== "object" || marker === null) return null;
  const count = (marker as { count?: unknown }).count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return null;
  }
  return { count };
}

/**
 * Put the archived prefix back in front of a parsed payload's `turns`
 * and drop the marker, in place. A payload without a marker keeps its
 * turns as they are. A row that will not parse is skipped: the
 * transcript then no longer matches its checkpoint, which
 * `normalizeSessionState` notices and drops, rather than the whole
 * session being lost.
 *
 * Without the archive (`statements` null: the table could not be read)
 * the payload is left exactly as it is, marker included. The state then
 * holds only the tail, and the marker on it is what tells the store's
 * writes so: they store that tail with the same marker and never treat
 * it as a whole transcript (see {@link carriesArchivedTurnsMarker}).
 */
export function restoreArchivedTurns(
  statements: TurnArchiveStatements | null,
  id: string,
  raw: Record<string, unknown>,
): void {
  if (statements === null) return;
  const marker = readArchivedTurnsMarker(raw);
  if (ARCHIVED_TURNS_KEY in raw) delete raw[ARCHIVED_TURNS_KEY];
  if (marker === null) return;
  const tail = Array.isArray(raw.turns) ? (raw.turns as unknown[]) : [];
  const turns: unknown[] = [];
  const rows = statements.read.iterate(id, marker.count) as IterableIterator<{
    turn: string;
  }>;
  for (const row of rows) {
    try {
      turns.push(JSON.parse(row.turn));
    } catch {
      // See above: skipped, the checkpoint check catches the gap.
    }
  }
  for (const turn of tail) turns.push(turn);
  raw.turns = turns;
}

/**
 * Whether a state still carries a payload marker: it was loaded while the
 * archive was unavailable, so its `turns` are only the tail after the
 * archived rows, not the whole transcript.
 */
export function carriesArchivedTurnsMarker(state: object): boolean {
  return readArchivedTurnsMarker(state as Record<string, unknown>) !== null;
}

/**
 * Remove the archived turns of deleted sessions. Tolerates a database
 * without the table (one only an older binary has opened).
 */
export function deleteArchivedTurns(
  db: Database.Database,
  ids: readonly string[],
): void {
  if (ids.length === 0) return;
  if (!turnArchiveTableExists(db)) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM ${TURN_ARCHIVE_TABLE} WHERE session_id IN (${placeholders})`,
  ).run(...ids);
}
