import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/index.js";
import {
  stripEphemeral,
  type SessionState,
  type SessionStatus,
} from "./session-state.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";
import type { SessionSummary } from "./session-summary.js";
import {
  summaryPageParams,
  SUMMARY_FIRST_PAGE_SQL,
  SUMMARY_NEXT_PAGE_SQL,
  toSummary,
  type SessionSummaryPageOptions,
  type SummaryRow,
} from "./session-summary-page.js";
import {
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_USER_SET_AT_KEY,
  readSessionTitle,
} from "./session-title.js";
import {
  readUserTitleSetAt,
  withUserSessionTitle,
} from "./session-title-user.js";
import {
  currentTurnOwnerProbe,
  databaseIdentity,
  isTurnOwnerGone,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "./turn-owner.js";
import {
  ensureTurnProgressColumn,
  parseTurnProgress,
  prepareTurnProgressStatements,
  serializeTurnProgress,
  type TurnProgress,
  type TurnProgressStatements,
} from "./turn-progress.js";
import {
  ARCHIVED_TURNS_KEY,
  TURN_ARCHIVE_TABLE,
  archivedTurnsMarker,
  carriesArchivedTurnsMarker,
  ensureTurnArchiveTable,
  prepareTurnArchiveStatements,
  restoreArchivedTurns,
  syncTurnArchive,
  turnArchiveTableExists,
  type TurnArchiveStatements,
} from "./turn-archive.js";
import {
  SessionSearchIndex,
  forgetSessionSearchRows,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "./session-search.js";

// `turn_owner` names the process running a turn on the row (see
// `beginTurn`) and is null otherwise — a shutdown's stand-in keeps it
// until the turn's own end or the store's last release (see
// `releaseOwnTurns`). Databases made before it existed get it from
// `ensureTurnOwnerColumn`; a binary that predates it never names the
// column, so it reads and writes such a file exactly as before.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  working_dir  TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  turn_owner   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_working_dir ON sessions(working_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_id ON sessions(updated_at DESC, id DESC);
`;

const COUNT_UNREADABLE_SQL = `SELECT COUNT(*) AS n FROM sessions WHERE NOT json_valid(payload)`;

/**
 * The user messages and closing replies of one session, in transcript
 * order, lifted out of the JSON in SQL with the summary page's guards
 * (see `session-summary-page.ts`). The `CASE` hands `json_each` an empty
 * document for a payload it cannot walk — a guard in `WHERE` would not
 * do, since `json_each` sits in the join, not in a subquery the `WHERE`
 * can short-circuit — and `t.type = 'object'` keeps `json_extract` off
 * elements that are not objects. Tool calls, tool results and progress
 * notes are left out; a JSON `true` reads back as `1`.
 */
const CHAT_LINES_SQL = `
SELECT json_extract(t.value, '$.kind') AS kind,
       json_extract(t.value, '$.text') AS text
  FROM sessions AS s,
       json_each(CASE WHEN json_valid(s.payload)
                       AND json_type(s.payload, '$.turns') = 'array'
                      THEN s.payload ELSE '{}' END,
                 '$.turns') AS t
 WHERE s.id = @id
   AND t.type = 'object'
   AND json_extract(t.value, '$.kind') IN ('user', 'assistant_reply')
   AND json_type(t.value, '$.text') = 'text'
   AND json_extract(t.value, '$.progressNote') IS NOT 1
 ORDER BY t.key ASC`;

/**
 * {@link CHAT_LINES_SQL} with the turns kept in the archive
 * (`turn-archive.ts`) read first: only the rows the payload's marker
 * counts, then the payload's own `turns`. Each arm keeps its guards in
 * its own `WHERE`, in the order the single-table query has them. An
 * archived row is always one whole JSON document, so `json_extract` on
 * it cannot raise; the `CASE` is there for a row written by hand.
 */
const CHAT_LINES_WITH_ARCHIVE_SQL = `
SELECT kind, text FROM (
  SELECT 0 AS part, a.idx AS ord,
         json_extract(CASE WHEN json_valid(a.turn) THEN a.turn ELSE '{}' END, '$.kind') AS kind,
         json_extract(CASE WHEN json_valid(a.turn) THEN a.turn ELSE '{}' END, '$.text') AS text
    FROM sessions AS s
    JOIN ${TURN_ARCHIVE_TABLE} AS a ON a.session_id = s.id
   WHERE s.id = @id
     AND json_valid(s.payload)
     AND a.idx < COALESCE(json_extract(s.payload, '$.${ARCHIVED_TURNS_KEY}.count'), 0)
     AND json_valid(a.turn)
     AND json_type(a.turn) = 'object'
     AND json_extract(a.turn, '$.kind') IN ('user', 'assistant_reply')
     AND json_type(a.turn, '$.text') = 'text'
     AND json_extract(a.turn, '$.progressNote') IS NOT 1
  UNION ALL
  SELECT 1 AS part, t.key AS ord,
         json_extract(t.value, '$.kind') AS kind,
         json_extract(t.value, '$.text') AS text
    FROM sessions AS s,
         json_each(CASE WHEN json_valid(s.payload)
                         AND json_type(s.payload, '$.turns') = 'array'
                        THEN s.payload ELSE '{}' END,
                   '$.turns') AS t
   WHERE s.id = @id
     AND t.type = 'object'
     AND json_extract(t.value, '$.kind') IN ('user', 'assistant_reply')
     AND json_type(t.value, '$.text') = 'text'
     AND json_extract(t.value, '$.progressNote') IS NOT 1
)
 ORDER BY part ASC, ord ASC`;

/** One line of `listChatLines`. */
export interface SessionChatLine {
  kind: "user" | "assistant_reply";
  text: string;
}

const LIVE_STATUS_SQL_LIST = LIVE_SESSION_STATUSES.map(
  (status) => `'${status}'`,
).join(", ");

const LIVE_STATUSES: ReadonlySet<string> = new Set(LIVE_SESSION_STATUSES);

/**
 * A status-only write. The column is where a row's status lives — every
 * reader takes it from there (`readPayload`) — so this moves the column
 * and touches the payload only to set `lastError`, keeping the payload's
 * own `status` in step while it is there. A payload that is not JSON is
 * left as it is: no reader can parse it anyway.
 */
const END_TURN_SQL = `status = @status,
       payload = CASE WHEN @set_last_error = 0 OR NOT json_valid(payload)
                      THEN payload
                      ELSE json_set(payload, '$.status', @status, '$.lastError', @last_error)
                 END`;

/**
 * How a turn that could not write its own end is recorded instead: the
 * status it ends on, and what becomes of `lastError` — a sentence to
 * set, `null` to clear it, absent to keep what the row has.
 */
export interface TurnEnding {
  readonly status: SessionStatus;
  readonly lastError?: string | null;
}

function endingParams(ending: TurnEnding): {
  status: SessionStatus;
  set_last_error: number;
  last_error: string | null;
} {
  return {
    status: ending.status,
    set_last_error: ending.lastError === undefined ? 0 : 1,
    last_error: ending.lastError ?? null,
  };
}

/** What a write needs to know about the row it is about to replace. */
interface StoredRow {
  /** The generated title, `null` when there is none. */
  title: string | null;
  /** When the operator set that title, `null` for a generated one. */
  titleSetByUserAt: number | null;
  status: string;
  turnOwner: string | null;
  /** How many leading turns the row keeps in the archive; 0 for none. */
  archivedCount: number;
}

/**
 * Whether writing `state` over `stored` would lose archived history
 * (ATO-1271), in which case the write is skipped:
 *
 * - the archive is unavailable and `state` is a whole transcript, while
 *   the row keeps its prefix in the archive: stored in full, the tail
 *   would stand for the whole history and the next write that can see
 *   the archive would find it unrelated and drop it;
 * - `state` is only a tail (loaded without the archive, so it still
 *   carries the marker) and the row no longer counts any archived turns:
 *   another write stored the transcript in full since, and writing the
 *   tail over it would leave nothing in front of it.
 */
function dropsArchivedHistory(
  state: SessionState,
  stored: StoredRow | undefined,
  archive: TurnArchiveStatements | null,
): boolean {
  const storedCount = stored?.archivedCount ?? 0;
  if (carriesArchivedTurnsMarker(state)) return storedCount === 0;
  return archive === null && storedCount > 0;
}

/**
 * The status a plain `save` may write over `stored`.
 *
 * A row's live status belongs to the turn that set it. While a row
 * carries a turn's mark the stored status stands, whatever the copy
 * being saved says — a model stamp from a copy read before the turn
 * would otherwise say the session is idle while it runs. And `save`
 * never writes a live status of its own: a copy read while a turn was
 * running would put `running` back after that turn had ended, with no
 * mark left that anything would ever take off. It keeps what the row
 * says instead, or `pending` where that is itself a live status nothing
 * owns.
 */
function statusForSave(
  incoming: SessionStatus,
  stored: StoredRow | undefined,
): SessionStatus {
  if (stored !== undefined && stored.turnOwner !== null) {
    return stored.status as SessionStatus;
  }
  if (!LIVE_STATUSES.has(incoming)) return incoming;
  if (stored === undefined || LIVE_STATUSES.has(stored.status)) {
    return "pending";
  }
  return stored.status as SessionStatus;
}

/**
 * A turn whose process stopped before the turn could write its end: the
 * app quit or was killed mid-turn, or the process died. `cancelled`, the
 * same status a stopped turn gets, because nothing failed — the turn was
 * cut off — and the sentence says by what.
 */
export const INTERRUPTED_TURN_ENDING: TurnEnding = {
  status: "cancelled",
  lastError: "turn interrupted: the agent stopped before it finished",
};

export interface SessionStoreOptions {
  dbFile?: string;
  /**
   * This process, as the turn marks it writes and the boot sweep see it.
   * Tests pin it; production reads it off the process and the host.
   */
  turnOwnerProbe?: TurnOwnerProbe;
  /**
   * How long a statement waits on another connection's lock before it
   * fails (better-sqlite3's `timeout`, 5 s by default). Tests shorten it.
   */
  busyTimeoutMs?: number;
  /**
   * Tests only: behave as if the archive table could not be created or
   * read (a read-only file, a write lock held past the busy timeout), and
   * never retry. See `turn-archive.ts`.
   */
  turnArchiveUnavailable?: boolean;
}

/** How long after a failed attempt the store tries the archive table again. */
const ARCHIVE_RETRY_MS = 30_000;

/** The statements that read and write turn marks (`beginTurn` and on). */
interface TurnMarkStatements {
  begin: Database.Statement;
  release: Database.Statement;
  standIn: Database.Statement;
  listLive: Database.Statement;
  recover: Database.Statement;
}

/** A write that would replace archived history with a tail; see `write`. */
function warnArchivedWriteSkipped(id: string): void {
  process.emitWarning(
    `session ${id}: not saved, its compacted turns are archived and the archive table is unavailable`,
    { code: "ATOMIC_SESSION_ARCHIVE_UNAVAILABLE" },
  );
}

/** A row as the readers select it: the id and status columns and the payload. */
interface StoredPayloadRow {
  id?: unknown;
  status?: unknown;
  payload: string;
}

/** Thrown inside a write transaction to roll it back; never escapes. */
const ROLLBACK = Symbol("rollback");

/** Narrow projection returned by `listRecentWorkingDirs`. */
export interface RecentWorkingDirRow {
  workingDir: string;
  updatedAt: number;
}

/**
 * Durable session persistence. The SessionState is serialised as JSON,
 * optimising for developer iteration over schema stability, except for the
 * turns a context compaction covers: those move to `session_turn_archive`
 * once, so a long session's every write does not re-serialise its whole
 * history (`turn-archive.ts`, ATO-1271).
 */
export class SessionStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly insertIfAbsentStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly selectStoredStmt: Database.Statement;
  private readonly selectStoredBareStmt: Database.Statement;
  private readonly listByWorkingDirStmt: Database.Statement;
  private readonly listRecentStmt: Database.Statement;
  private readonly listRecentDirsStmt: Database.Statement;
  private readonly summaryFirstPageStmt: Database.Statement;
  private readonly summaryNextPageStmt: Database.Statement;
  private readonly countUnreadableStmt: Database.Statement;
  private readonly chatLinesStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly finishTurnStmt: Database.Statement;
  /**
   * `null` while this database has no `turn_owner` column — the open that
   * should have added it could not (`turnMarksUnavailable`). Every turn
   * mark method is then a no-op, and the store works as it did before
   * marks existed.
   */
  private readonly marks: TurnMarkStatements | null;
  private readonly marksUnavailable: string | null;
  /**
   * Turn progress markers (`turn-progress.ts`): `null` while this
   * database has no `turn_progress` column, or no turn marks to guard
   * them with. Checkpoints are then skipped and the store works as it
   * did before them.
   */
  private readonly progress: TurnProgressStatements | null;
  /**
   * The archive of compacted turns (`turn-archive.ts`, ATO-1271), or
   * `null` while the table could not be created or read. Retried lazily
   * (`turnArchive`), never given up on for the store's lifetime: a lock
   * held at open must not leave this process unable to read archived
   * history that another process wrote.
   */
  private archiveStatements: TurnArchiveStatements | null = null;
  private archiveChatLinesStmt: Database.Statement | null = null;
  private archiveRetryAt = 0;
  private readonly archiveForcedOff: boolean;
  /** The database file's real path, as marks record it; `undefined` in memory. */
  private readonly dbIdentity: string | undefined;
  /**
   * How many rows `load` / `listRecent` / `listByWorkingDir` have skipped
   * because their payload would not parse. Counts every skip, so the
   * same bad row read twice counts twice; `countUnreadable` is the
   * number of such rows in the table.
   */
  private unreadableSkips = 0;
  private readonly turnOwnerProbe: TurnOwnerProbe;
  /**
   * The rows this store has marked `running` and not yet ended, with the
   * exact mark it wrote on each — so a release only ever clears its own
   * mark, never one another process put there since.
   */
  private readonly ownTurns = new Map<string, string>();
  /** Built on the first search (ATO-1149); see `session-search.ts`. */
  private searchIndex: SessionSearchIndex | null = null;

  constructor(options: SessionStoreOptions = {}) {
    const config = getConfig();
    const file = options.dbFile ?? config.paths.sessionsDbFile;
    mkdirSync(dirname(file), { recursive: true });
    this.db =
      options.busyTimeoutMs === undefined
        ? new DatabaseCtor(file)
        : new DatabaseCtor(file, { timeout: options.busyTimeoutMs });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.marksUnavailable = ensureTurnOwnerColumn(this.db);
    const withMarks = this.marksUnavailable === null;
    // Checkpoints are guarded on the turn's mark, so they need both.
    const withProgress =
      withMarks && ensureTurnProgressColumn(this.db) === null;
    this.archiveForcedOff = options.turnArchiveUnavailable === true;
    this.turnArchive();
    this.turnOwnerProbe = options.turnOwnerProbe ?? currentTurnOwnerProbe();
    this.dbIdentity = databaseIdentity(file);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
       VALUES (@id, @working_dir, @status, @payload, @created_at, @updated_at)`,
    );
    // Names no `turn_owner`: a copied row never carries a turn mark.
    this.insertIfAbsentStmt = this.db.prepare(
      `INSERT OR IGNORE INTO sessions (id, working_dir, status, payload, created_at, updated_at)
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
    // Every reader takes `status` from the column, beside the payload:
    // see `readPayload`.
    this.selectStmt = this.db.prepare(
      `SELECT id, status, payload FROM sessions WHERE id = ?`,
    );
    // Projected in SQL rather than parsed in JS: `save` runs this on
    // every write, and a transcript payload is the one thing in this
    // row worth not re-parsing.
    const turnOwnerColumn = withMarks ? "turn_owner" : "NULL";
    this.selectStoredStmt = this.db.prepare(
      `SELECT status, ${turnOwnerColumn} AS turnOwner,
              json_extract(payload, '$.metadata.${SESSION_TITLE_METADATA_KEY}') AS title,
              json_extract(payload, '$.metadata.${SESSION_TITLE_USER_SET_AT_KEY}') AS titleSetByUserAt,
              json_extract(payload, '$.${ARCHIVED_TURNS_KEY}.count') AS archivedCount
       FROM sessions WHERE id = ?`,
    );
    this.selectStoredBareStmt = this.db.prepare(
      `SELECT status, ${turnOwnerColumn} AS turnOwner FROM sessions WHERE id = ?`,
    );
    this.listByWorkingDirStmt = this.db.prepare(
      `SELECT id, status, payload FROM sessions WHERE working_dir = ? ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentStmt = this.db.prepare(
      `SELECT id, status, payload FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentDirsStmt = this.db.prepare(
      `SELECT working_dir AS workingDir, updated_at AS updatedAt
       FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    );
    // Two statements, one SQL text: the cursor has to be absent from
    // the first page's `WHERE` for SQLite to plan a plain index walk,
    // and present in the rest for it to plan a range seek. A single
    // statement with a nullable cursor gets neither.
    this.summaryFirstPageStmt = this.db.prepare(SUMMARY_FIRST_PAGE_SQL);
    this.summaryNextPageStmt = this.db.prepare(SUMMARY_NEXT_PAGE_SQL);
    this.countUnreadableStmt = this.db.prepare(COUNT_UNREADABLE_SQL);
    this.chatLinesStmt = this.db.prepare(CHAT_LINES_SQL);
    this.deleteStmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    this.finishTurnStmt = withMarks
      ? this.db.prepare(
          `UPDATE sessions
           SET working_dir = @working_dir,
               status = @status,
               payload = @payload,
               updated_at = @updated_at,
               turn_owner = NULL
           WHERE id = @id`,
        )
      : this.updateStmt;
    this.marks = withMarks ? this.prepareMarkStatements() : null;
    this.progress = withProgress
      ? prepareTurnProgressStatements(this.db)
      : null;
  }

  /**
   * Why this store runs without turn marks, or `null` when it has them:
   * the open that should have added the `turn_owner` column to an older
   * database could not (another process held the write lock past the
   * busy timeout, a file this process may only read). Sessions are
   * stored as before, no turn is marked, and the next open tries the
   * column again. Bootstrap logs it.
   */
  get turnMarksUnavailable(): string | null {
    return this.marksUnavailable;
  }

  private prepareMarkStatements(): TurnMarkStatements {
    return {
      // Two columns and nothing else, at every turn start: the payload is
      // not rewritten (readers take the status from the column), and
      // `updated_at` is left alone — the row's content has not changed,
      // and it is what every list orders by and the desktop reads
      // "unread" from.
      begin: this.db.prepare(
        `UPDATE sessions SET status = 'running', turn_owner = @owner WHERE id = @id`,
      ),
      release: this.db.prepare(
        `UPDATE sessions
         SET ${END_TURN_SQL},
             turn_owner = NULL
         WHERE id = @id AND turn_owner IS @owner`,
      ),
      // The same, keeping the mark: a stand-in the turn's own end can
      // still replace (`releaseOwnTurns` with `keepMarks`).
      standIn: this.db.prepare(
        `UPDATE sessions
         SET ${END_TURN_SQL}
         WHERE id = @id AND turn_owner IS @owner`,
      ),
      // By status, not by mark: `idx_sessions_status` keeps this to the
      // few rows that claim a live turn, and reading `turn_owner` — stored
      // after the payload — on every row would read every transcript.
      listLive: this.db.prepare(
        `SELECT id, status, turn_owner AS turnOwner
         FROM sessions WHERE status IN (${LIVE_STATUS_SQL_LIST})`,
      ),
      // Guarded on what the sweep read, so a turn another process started
      // on the row in between keeps its mark.
      recover: this.db.prepare(
        `UPDATE sessions
         SET ${END_TURN_SQL},
             turn_owner = NULL
         WHERE id = @id AND status = @read_status AND turn_owner IS @owner`,
      ),
    };
  }

  /**
   * Persist a session, without erasing a name it was given while the
   * caller was holding its copy.
   *
   * The generated title is the one field written *after* a turn returns
   * — the naming call takes a second or two and lands long after
   * `executeTurn` handed the finished session back. Every caller that
   * then saves its own snapshot (the `run` CLI's final write, the TUI's
   * model stamp) is holding a state from before that, and a plain
   * overwrite drops the name. Observed exactly that way: the title was
   * written and read back in-process, and was gone from the row once
   * the process exited.
   *
   * So the rule is the store's, not each caller's: a write that carries
   * no title does not remove one. The namer never renames a session —
   * `shouldNameSession` refuses to name a session twice — so "keep what
   * is there" is also the product behaviour. The operator can rename one
   * (`renameSession`); that title is stamped, and a copy without the
   * stamp, or with an older one, cannot write over it.
   *
   * And the status a turn set is the turn's own (`statusForSave`): a
   * save never writes a live status, and never changes the status of a
   * row a turn has marked. Only the turn's own end — `finishTurn` or
   * `releaseTurn` — moves it, and takes the mark off.
   */
  save(state: SessionState): void {
    this.write(state, false);
  }

  /**
   * Mark a session `running` for the turn about to run on it, and
   * remember which process is running it, in the row itself.
   *
   * Before this the row only ever held a turn's end, written by
   * `executeTurn` once the turn returned. A turn that never got there —
   * the app closed mid-turn, the process killed or crashed — left the
   * row as it was before the turn, so a turn that had been sent and then
   * cut off looked like a session where nothing had happened. Now the
   * row says a turn is running from the moment one starts, every way the
   * turn ends replaces that (`finishTurn`, `releaseTurn`), and a mark
   * whose process is gone is cleared at the next boot
   * (`recoverInterruptedTurns`).
   *
   * Only an existing row is marked: a session nobody has saved yet (the
   * TUI's deferred first turn) gets its row from `finishTurn`, as before.
   * Returns whether a row was marked.
   */
  beginTurn(
    id: string,
    now: number = Date.now(),
    progress?: TurnProgress,
  ): boolean {
    if (this.marks === null) return false;
    const owner = serializeTurnOwner(
      turnOwnerFor(this.turnOwnerProbe, now, this.dbIdentity),
    );
    const result = this.marks.begin.run({ id, owner }) as {
      changes: number;
    };
    if (result.changes === 0) return false;
    this.ownTurns.set(id, owner);
    // A new turn replaces whatever an earlier, interrupted one left: its
    // own marker when it has one, none otherwise.
    this.progress?.set.run({
      id,
      owner,
      progress: progress === undefined ? null : serializeTurnProgress(progress),
    });
    return true;
  }

  /**
   * One step's checkpoint (ATO-1109): the transcript as the turn now has
   * it and the turn's progress marker, in one row write, while the row
   * still carries this store's mark for the turn. Status and title are
   * not touched: the turn's end (`finishTurn`) writes those. Returns
   * whether the row was written; a turn on a row this store did not
   * mark (a deferred first turn, a database without marks) is not
   * checkpointed.
   */
  checkpointTurn(state: SessionState, progress: TurnProgress): boolean {
    const owner = this.ownTurns.get(state.id);
    if (owner === undefined || this.progress === null) return false;
    // The loop's copy was read before the turn started: a rename or the
    // namer's title written since is only in the row, and replacing the
    // payload without it would lose it for good (`finishTurn` reads the
    // row's title to keep it).
    const progressStatements = this.progress;
    const archive = this.turnArchive();
    // One transaction with the archive rows the write adds, rolled back
    // when the guard finds the row no longer this turn's: archive rows
    // written for a payload that was never stored would not match the
    // payload that is.
    return this.inWriteTransaction(() => {
      const stored = this.storedRow(state.id);
      if (dropsArchivedHistory(state, stored, archive)) {
        warnArchivedWriteSkipped(state.id);
        throw ROLLBACK;
      }
      const row = this.serialize(withStoredTitle(state, stored), archive);
      const result = progressStatements.checkpoint.run({
        id: state.id,
        owner,
        payload: row.payload,
        updated_at: row.updated_at,
        progress: serializeTurnProgress(progress),
      }) as { changes: number };
      if (result.changes === 0) throw ROLLBACK;
      return true;
    }, false);
  }

  /**
   * The progress marker a turn left on the row (`turn-progress.ts`), or
   * `null` when there is none: no turn was cut off, or the last one
   * ended on its own.
   */
  readTurnProgress(id: string): TurnProgress | null {
    if (this.progress === null) return null;
    const row = this.progress.read.get(id) as
      | { progress: string | null }
      | undefined;
    return row === undefined ? null : parseTurnProgress(row.progress);
  }

  /** Drop a row's progress marker: its work was continued or given up on. */
  clearTurnProgress(id: string): void {
    this.progress?.clear.run(id);
  }

  /**
   * Persist the state a turn ended with, and take the turn's mark off
   * the row. Same title rule as `save`; inserts the row when there is
   * none (a deferred session's first turn, or one deleted mid-turn).
   *
   * The turn stays this store's until the write has gone through: one
   * that fails (a lock held too long, a full disk) leaves it to
   * `releaseTurn` and, at shutdown, `releaseOwnTurns` — rather than a
   * row that says `running` for as long as this process lives, under a
   * pid no sweep will ever call gone.
   */
  finishTurn(state: SessionState): void {
    this.write(state, true);
    this.ownTurns.delete(state.id);
    // A turn that ended on its own leaves nothing to continue; one that
    // was stopped keeps its marker (`TurnProgress`, "Lifetime").
    if (state.status !== "cancelled") this.progress?.clear.run(state.id);
  }

  /**
   * End a turn this store marked without the state it ended with — it
   * threw, or the runtime is closing under it — by writing `ending` as
   * its status. Touches the row only while it still carries this store's
   * own mark: a turn that wrote its end already, or one another process
   * has since started on the row, is left as it is. A failed write keeps
   * the turn this store's, as in `finishTurn`. Returns whether the row
   * was changed.
   */
  releaseTurn(id: string, ending: TurnEnding): boolean {
    const owner = this.ownTurns.get(id);
    if (owner === undefined || this.marks === null) return false;
    const result = this.marks.release.run({
      id,
      owner,
      ...endingParams(ending),
    }) as { changes: number };
    this.ownTurns.delete(id);
    if (result.changes > 0 && ending.status !== "cancelled") {
      this.progress?.clear.run(id);
    }
    return result.changes > 0;
  }

  /**
   * Write `ending` on every row this store still has marked: shutdown,
   * where a turn that has not written its end by now never will.
   *
   * `keepMarks` is for the top of a shutdown. The ending goes in as a
   * stand-in — right away, so a stop that turns into a kill partway
   * through teardown still leaves every row right — but the marks stay,
   * and so does this store's record of them: a turn that still gets to
   * its own end, through `finishTurn` or through `releaseTurn` when it
   * throws, replaces the stand-in with what really happened. Without it
   * the marks come off and the store forgets them, the last word before
   * it closes.
   *
   * A row whose write fails does not stop the others; the first error is
   * thrown once every row has been tried. Returns how many rows changed.
   */
  releaseOwnTurns(
    ending: TurnEnding,
    options: { keepMarks?: boolean } = {},
  ): number {
    if (this.marks === null) return 0;
    const keepMarks = options.keepMarks === true;
    const statement = keepMarks ? this.marks.standIn : this.marks.release;
    let changed = 0;
    let failure: { error: unknown } | undefined;
    for (const [id, owner] of [...this.ownTurns]) {
      try {
        const result = statement.run({
          id,
          owner,
          ...endingParams(ending),
        }) as { changes: number };
        if (result.changes > 0) changed += 1;
        if (!keepMarks) this.ownTurns.delete(id);
      } catch (err) {
        failure ??= { error: err };
      }
    }
    if (failure !== undefined) throw failure.error;
    return changed;
  }

  /**
   * The boot sweep: every row still claiming a live turn
   * (`LIVE_SESSION_STATUSES`) whose owning process is gone gets
   * `ending` — by default `INTERRUPTED_TURN_ENDING` — so lists stop
   * showing a turn nothing is running. A row a live process still owns
   * is left alone: the store is shared by every process on the state dir
   * (a second TUI window, `serve` beside a TUI), and their turns are
   * theirs. Rows this store marked itself are never touched.
   *
   * `isOwnerGone` defaults to `isTurnOwnerGone` against this process;
   * the default is only right at boot, before this process has started a
   * turn (see there). Run as one `BEGIN IMMEDIATE` transaction: it reads
   * and then writes, and a deferred one would fail outright when another
   * process committed in between instead of waiting for the lock. Returns
   * the ids it ended.
   */
  recoverInterruptedTurns(
    options: {
      isOwnerGone?: (owner: string | null) => boolean;
      ending?: TurnEnding;
    } = {},
  ): string[] {
    const marks = this.marks;
    if (marks === null) return [];
    const probe = this.turnOwnerProbe;
    const db = this.dbIdentity;
    const isOwnerGone: (owner: string | null) => boolean =
      options.isOwnerGone ?? ((owner) => isTurnOwnerGone(owner, probe, db));
    const ending = endingParams(options.ending ?? INTERRUPTED_TURN_ENDING);
    const sweep = this.db.transaction((): string[] => {
      const rows = marks.listLive.all() as Array<{
        id: string;
        status: string;
        turnOwner: string | null;
      }>;
      const recovered: string[] = [];
      for (const row of rows) {
        if (this.ownTurns.has(row.id)) continue;
        if (!isOwnerGone(row.turnOwner)) continue;
        const result = marks.recover.run({
          id: row.id,
          read_status: row.status,
          owner: row.turnOwner,
          ...ending,
        }) as { changes: number };
        if (result.changes > 0) recovered.push(row.id);
      }
      return recovered;
    });
    return sweep.immediate();
  }

  /**
   * One row write: `save` (`endsTurn` false) or a turn's own end
   * (`finishTurn`). Both keep a stored title the state does not carry;
   * only `save` is held to `statusForSave`.
   */
  private write(state: SessionState, endsTurn: boolean): void {
    const archive = this.turnArchive();
    // One transaction: the archive rows the write adds and the payload
    // that counts them land together or not at all.
    this.inWriteTransaction(() => {
      const stored = this.storedRow(state.id);
      // Without the archive, a state that is a whole transcript cannot
      // be split, and storing it in full over a row whose prefix lives in
      // the archive would make that prefix unreachable, and the next
      // write elsewhere would drop it. Skipped instead (ATO-1271).
      if (dropsArchivedHistory(state, stored, archive)) {
        warnArchivedWriteSkipped(state.id);
        return;
      }
      const status = endsTurn
        ? state.status
        : statusForSave(state.status, stored);
      let next: SessionState =
        status === state.status ? state : { ...state, status };
      if (stored === undefined) {
        this.insertStmt.run(this.serialize(next, archive));
        return;
      }
      next = withStoredTitle(next, stored);
      const update = endsTurn ? this.finishTurnStmt : this.updateStmt;
      update.run(this.serialize(next, archive));
    }, undefined);
  }

  /**
   * Run `fn` in one `BEGIN IMMEDIATE` transaction, so the write lock is
   * waited for (busy timeout) up front rather than failing on an upgrade
   * from read to write. `fn` throws {@link ROLLBACK} to undo its writes
   * and return `onRollback`; any other error rolls back and propagates.
   */
  /**
   * The archive statements, creating the table when it is missing. A
   * failed attempt is retried after {@link ARCHIVE_RETRY_MS}; a table
   * another process created is picked up at once, since finding it is a
   * plain read. Call outside a statement iteration.
   */
  private turnArchive(): TurnArchiveStatements | null {
    if (this.archiveStatements !== null || this.archiveForcedOff) {
      return this.archiveStatements;
    }
    const now = Date.now();
    try {
      const exists = turnArchiveTableExists(this.db);
      if (!exists && now < this.archiveRetryAt) return null;
      if (exists || ensureTurnArchiveTable(this.db) === null) {
        this.archiveStatements = prepareTurnArchiveStatements(this.db);
        this.archiveChatLinesStmt = this.db.prepare(CHAT_LINES_WITH_ARCHIVE_SQL);
        return this.archiveStatements;
      }
    } catch {
      // Fall through: retried later.
    }
    this.archiveRetryAt = now + ARCHIVE_RETRY_MS;
    return null;
  }

  private inWriteTransaction<T>(fn: () => T, onRollback: T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (err) {
      if (err === ROLLBACK) return onRollback;
      throw err;
    }
  }

  /**
   * What a write needs from the row it replaces, or `undefined` when
   * there is no such row.
   *
   * `json_extract` raises on a payload that is not valid JSON, and this
   * table tolerates those (see `countUnreadable`) — a corrupt row must
   * not make saving impossible, so it falls back to the columns alone
   * and reads as having no title.
   */
  private storedRow(id: string): StoredRow | undefined {
    let row:
      | {
          status: string;
          turnOwner: string | null;
          title?: unknown;
          titleSetByUserAt?: unknown;
          archivedCount?: unknown;
        }
      | undefined;
    try {
      row = this.selectStoredStmt.get(id) as typeof row;
    } catch {
      row = this.selectStoredBareStmt.get(id) as typeof row;
    }
    if (row === undefined) return undefined;
    return {
      title:
        typeof row.title === "string" && row.title.trim().length > 0
          ? row.title
          : null,
      titleSetByUserAt:
        typeof row.titleSetByUserAt === "number" &&
        Number.isFinite(row.titleSetByUserAt)
          ? row.titleSetByUserAt
          : null,
      status: row.status,
      turnOwner: row.turnOwner,
      archivedCount:
        typeof row.archivedCount === "number" &&
        Number.isInteger(row.archivedCount) &&
        row.archivedCount > 0
          ? row.archivedCount
          : 0,
    };
  }

  /**
   * Copy sessions from another state dir into this one, keeping their
   * ids: the desktop's own dir merged into the shared one (ATO-416). A
   * row whose id is already here is left exactly as it is — what this
   * store holds wins — and the copy is dropped.
   *
   * A copied row never carries a turn: no `turn_owner` is written, and a
   * live status (a turn that was running when the other dir's process
   * stopped) is ended the way the boot sweep ends one whose process is
   * gone (`INTERRUPTED_TURN_ENDING`). Otherwise the lists would show a
   * turn nothing here is running.
   *
   * One `BEGIN IMMEDIATE` transaction per call, so the write lock is
   * waited for (busy timeout) rather than failing on an upgrade while a
   * TUI or `serve` writes the same file; callers keep batches small so
   * the lock is never held for long. Returns the ids inserted.
   */
  insertMissing(states: readonly SessionState[]): string[] {
    const insert = this.db.transaction(
      (batch: readonly SessionState[]): string[] => {
        const inserted: string[] = [];
        for (const state of batch) {
          // Stored in full: archiving here would write rows for a copy
          // the `OR IGNORE` may then drop. The next write archives it.
          const result = this.insertIfAbsentStmt.run(
            this.serialize(endLiveTurn(state), null),
          ) as { changes: number };
          if (result.changes > 0) inserted.push(state.id);
        }
        return inserted;
      },
    );
    return insert.immediate(states);
  }

  /**
   * Set the operator's title on a stored session, stamped so neither the
   * namer nor a stale copy can write over it (see `save`). Returns the
   * saved state, or `null` when there is no such session. `updatedAt` is
   * left as it was: naming a chat is not activity in it, and a rename
   * should not move the row to the top of the list.
   */
  renameSession(
    id: string,
    title: string,
    now: number = Date.now(),
  ): SessionState | null {
    const current = this.load(id);
    if (current === null) return null;
    const next = withUserSessionTitle(current, title, now);
    this.save(next);
    return next;
  }

  load(id: string): SessionState | null {
    const archive = this.turnArchive();
    // One read transaction, so the payload and the archived turns it
    // counts come from the same snapshot of the file.
    return this.db.transaction((): SessionState | null => {
      const row = this.selectStmt.get(id) as StoredPayloadRow | undefined;
      if (!row) return null;
      return this.readPayload(row, archive);
    })();
  }

  listByWorkingDir(workingDir: string, limit = 25): SessionState[] {
    const archive = this.turnArchive();
    return this.db.transaction((): SessionState[] => {
      const rows = this.listByWorkingDirStmt.all(
        workingDir,
        limit,
      ) as StoredPayloadRow[];
      return this.readPayloads(rows, archive);
    })();
  }

  /**
   * Return the most recently updated sessions across all working dirs.
   * Used by the TUI session picker so the operator can jump between
   * ongoing threads from any project root.
   */
  listRecent(limit = 25): SessionState[] {
    const archive = this.turnArchive();
    return this.db.transaction((): SessionState[] => {
      const rows = this.listRecentStmt.all(limit) as StoredPayloadRow[];
      return this.readPayloads(rows, archive);
    })();
  }

  /**
   * One page of list rows, newest first, projected in SQL (see
   * `session-summary-page.ts`). `after` resumes from the cursor a
   * previous page ended on — `sessionSummaryCursorAfter(page)` builds
   * it — so walking the table costs the same per page however deep the
   * walk goes.
   *
   * There is deliberately no whole-table reader. This query used to run
   * without a LIMIT on the theory that the rail windows its own rows,
   * and it does — but better-sqlite3 is synchronous, so the read froze
   * the Ink thread for as long as it took: 30 ms at 1 100 stored rows,
   * 170 ms at 6 600, 540 ms at 22 000, on every boot, every switch and
   * the end of every turn. A caller that wants more than one page asks
   * for the next one.
   *
   * Rows whose payload is not valid JSON or whose `turns` is not an
   * array are left out, as are rows nobody has spoken to;
   * `countUnreadable` says how many of the first kind there are.
   */
  listSummaryPage(options: SessionSummaryPageOptions): SessionSummary[] {
    const stmt = options.after
      ? this.summaryNextPageStmt
      : this.summaryFirstPageStmt;
    const rows = stmt.all(summaryPageParams(options)) as SummaryRow[];
    return rows.map(toSummary);
  }

  /**
   * The user messages and closing replies of one stored session, in
   * order — what the profile's name check reads (ATO-199). Projected in
   * SQL, so a long transcript's tool output is never parsed; empty for
   * an unknown id or a payload that will not parse.
   */
  listChatLines(id: string): SessionChatLine[] {
    this.turnArchive();
    const stmt = this.archiveChatLinesStmt ?? this.chatLinesStmt;
    return stmt.all({ id }) as SessionChatLine[];
  }

  /**
   * Full-text search over the user messages and closing replies of every
   * stored session (ATO-1149). The index is created on the first call and
   * brought up to date by each one; see `session-search.ts`. Throws
   * `SessionSearchUnavailableError` when the index cannot be created.
   */
  searchTranscripts(options: SessionSearchOptions): SessionSearchResult {
    this.searchIndex ??= new SessionSearchIndex(this.db, (id) =>
      this.listChatLines(id),
    );
    return this.searchIndex.search(options);
  }

  /** Rows whose payload is not valid JSON — the ones every reader skips. */
  countUnreadable(): number {
    const row = this.countUnreadableStmt.get() as { n: number };
    return row.n;
  }

  /** Skips recorded by `load` / `listRecent` / `listByWorkingDir` so far. */
  get unreadableRowsSkipped(): number {
    return this.unreadableSkips;
  }

  /**
   * Column-only projection of the most recently updated sessions.
   * `os.fs.locate_project` calls this on demand (potentially inside a
   * pure_read fan-out batch), so it must not pay `listRecent`'s
   * JSON.parse of every full session payload — `working_dir` and
   * `updated_at` already live as columns.
   */
  listRecentWorkingDirs(limit = 25): RecentWorkingDirRow[] {
    return this.listRecentDirsStmt.all(limit) as RecentWorkingDirRow[];
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.deleteStmt.run(id);
      this.archiveStatements?.clear.run(id);
      // A deleted chat's text leaves the search index with it.
      forgetSessionSearchRows(this.db, id);
    })();
  }

  /**
   * The live `better-sqlite3` handle, for the startup retention pass
   * (`pruneSessions`). The same connection on purpose: a second one
   * would sit behind this one's WAL write lock for the whole prune,
   * which is exactly the boot-time stall the batching exists to avoid.
   *
   * Do not stash the handle outside the runtime — its lifetime belongs
   * to this store and it dies with `close()`.
   */
  getDatabaseHandleForRetention(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Parse one stored payload, or `null` when it will not parse. A row
   * that is not JSON — a truncated write, a hand edit — used to throw
   * out of every list and empty the rail; now it is skipped and counted.
   *
   * The status comes from the column, not the payload: `beginTurn` moves
   * only the column (rewriting a whole transcript to flip one word at
   * every turn start is not worth it), so the payload's copy can be a
   * turn behind.
   */
  private readPayload(
    row: StoredPayloadRow,
    archive: TurnArchiveStatements | null,
  ): SessionState | null {
    let state: SessionState;
    try {
      const raw: unknown = JSON.parse(row.payload);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        // The archived prefix goes back in front before the checkpoint
        // is checked against the transcript (ATO-1271).
        const record = raw as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : record.id;
        if (typeof id === "string") {
          restoreArchivedTurns(archive, id, record);
        }
        state = normalizeSessionState(raw);
        if (carriesArchivedTurnsMarker(record)) {
          // Loaded without the archive: only the tail is here, which no
          // checkpoint matches. Keep the stored checkpoint and rolling
          // summary as they are, so a save of this tail does not drop
          // them; every reader validates them and sees none (ATO-1271).
          state = keepStoredCheckpoint(state, record);
        }
      } else {
        state = normalizeSessionState(raw);
      }
    } catch {
      this.unreadableSkips += 1;
      return null;
    }
    return typeof row.status === "string"
      ? { ...state, status: row.status as SessionStatus }
      : state;
  }

  private readPayloads(
    rows: StoredPayloadRow[],
    archive: TurnArchiveStatements | null,
  ): SessionState[] {
    const states: SessionState[] = [];
    for (const row of rows) {
      const state = this.readPayload(row, archive);
      if (state) states.push(state);
    }
    return states;
  }

  /**
   * The row for `state`. With the archive on, the turns a compaction
   * covers are written to it (once each) and left out of the payload,
   * which then carries only the rest and a marker counting them
   * (`turn-archive.ts`, ATO-1271). Writes archive rows, so callers run it
   * inside the transaction that writes the row. `archive` null stores the
   * transcript in full.
   *
   * A state that still carries a marker was loaded without the archive:
   * its `turns` are only the tail, so it is written back as it is, marker
   * and all, and the archive is not touched. Comparing that tail with the
   * archived rows would find them unrelated and drop them.
   */
  private serialize(
    state: SessionState,
    archive: TurnArchiveStatements | null,
  ): Record<string, unknown> {
    const persistable = stripEphemeral(state) as SessionState & {
      [ARCHIVED_TURNS_KEY]?: unknown;
    };
    if (carriesArchivedTurnsMarker(persistable)) {
      return {
        id: persistable.id,
        working_dir: persistable.workingDir,
        status: persistable.status,
        payload: JSON.stringify(persistable),
        created_at: persistable.createdAt,
        updated_at: persistable.updatedAt,
      };
    }
    const archived =
      archive !== null ? syncTurnArchive(archive, persistable) : 0;
    // Only a malformed marker can be left here (a valid one returned
    // above); drop it so it cannot miscount.
    const { [ARCHIVED_TURNS_KEY]: _marker, ...rest } = persistable;
    const payload =
      archived === 0
        ? JSON.stringify(rest)
        : JSON.stringify({
            ...rest,
            turns: persistable.turns.slice(archived),
            [ARCHIVED_TURNS_KEY]: archivedTurnsMarker(
              persistable.turns,
              archived,
            ),
          });
    return {
      id: persistable.id,
      working_dir: persistable.workingDir,
      status: persistable.status,
      payload,
      created_at: persistable.createdAt,
      updated_at: persistable.updatedAt,
    };
  }
}

/** `state` with the checkpoint fields of the stored payload put back. */
function keepStoredCheckpoint(
  state: SessionState,
  record: Record<string, unknown>,
): SessionState {
  const next: SessionState = { ...state };
  delete next.compactionWarning;
  if (record.compaction !== undefined) {
    next.compaction = record.compaction as SessionState["compaction"];
  }
  if (record.rollingSummary !== undefined) {
    next.rollingSummary = record.rollingSummary as SessionState["rollingSummary"];
  }
  return next;
}

/** `state` with a live status ended as an interrupted turn; others as they are. */
function endLiveTurn(state: SessionState): SessionState {
  if (!LIVE_STATUSES.has(state.status)) return state;
  return {
    ...state,
    status: INTERRUPTED_TURN_ENDING.status,
    lastError: INTERRUPTED_TURN_ENDING.lastError ?? state.lastError,
  };
}

/**
 * Give a `sessions` table made before turn marks existed its
 * `turn_owner` column. Additive and nullable, so every existing row
 * reads as "no turn running" and an older binary sharing the file is
 * unaffected. Two processes can open an old file at once; the one that
 * loses the race to add the column finds it there.
 *
 * Adding it takes the write lock, which the first open after an upgrade
 * may not get — another process mid-`VACUUM` past the busy timeout — or
 * the write can fail: a database file this process may only read opens,
 * reads and passes the schema check above, and refuses only this. That
 * must not keep the runtime from starting: the store runs without turn
 * marks (`turnMarksUnavailable`) and the next open tries again. Returns
 * why the column is missing, or `null`.
 */
function ensureTurnOwnerColumn(db: Database.Database): string | null {
  try {
    const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "turn_owner")) return null;
    db.exec(`ALTER TABLE sessions ADD COLUMN turn_owner TEXT`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return /duplicate column/i.test(message) ? null : message;
  }
}

/**
 * `next` with the title the stored row carries where `next` should not
 * replace it: the operator's stamped name over any copy without the
 * stamp or with an older one, and any stored title over a copy with
 * none. Shared by every write that replaces a row's payload.
 */
function withStoredTitle(
  next: SessionState,
  stored: StoredRow | undefined,
): SessionState {
  if (stored === undefined) return next;
  const storedUserAt = stored.titleSetByUserAt;
  const nextUserAt = readUserTitleSetAt(next.metadata);
  if (
    stored.title !== null &&
    storedUserAt !== null &&
    (nextUserAt === null || nextUserAt < storedUserAt)
  ) {
    // The operator's name outranks any copy read before the rename —
    // a turn that was running, the namer's late answer, a TUI stamp —
    // whatever title that copy carries.
    return {
      ...next,
      metadata: {
        ...next.metadata,
        [SESSION_TITLE_METADATA_KEY]: stored.title,
        [SESSION_TITLE_USER_SET_AT_KEY]: storedUserAt,
      },
    };
  }
  if (
    stored.title !== null &&
    readSessionTitle(next.metadata) === null
  ) {
    return {
      ...next,
      metadata: {
        ...next.metadata,
        [SESSION_TITLE_METADATA_KEY]: stored.title,
      },
    };
  }
  return next;
}
