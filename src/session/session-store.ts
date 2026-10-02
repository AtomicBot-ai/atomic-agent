import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  readSessionTitle,
} from "./session-title.js";
import {
  currentTurnOwnerProbe,
  isTurnOwnerGone,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "./turn-owner.js";

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
  status: string;
  turnOwner: string | null;
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
}

/** The statements that read and write turn marks (`beginTurn` and on). */
interface TurnMarkStatements {
  begin: Database.Statement;
  release: Database.Statement;
  standIn: Database.Statement;
  listLive: Database.Statement;
  recover: Database.Statement;
}

/** A row as the readers select it: the status column and the payload. */
interface StoredPayloadRow {
  status?: unknown;
  payload: string;
}

/** Narrow projection returned by `listRecentWorkingDirs`. */
export interface RecentWorkingDirRow {
  workingDir: string;
  updatedAt: number;
}

/**
 * Durable session persistence. We serialise the whole SessionState as JSON
 * because it is small (<10 KB) and we optimise for developer iteration
 * over schema stability. A columnar migration can come later.
 */
export class SessionStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
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
    this.turnOwnerProbe = options.turnOwnerProbe ?? currentTurnOwnerProbe();
    this.dbIdentity = databaseIdentity(file);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
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
      `SELECT status, payload FROM sessions WHERE id = ?`,
    );
    // Projected in SQL rather than parsed in JS: `save` runs this on
    // every write, and a transcript payload is the one thing in this
    // row worth not re-parsing.
    const turnOwnerColumn = withMarks ? "turn_owner" : "NULL";
    this.selectStoredStmt = this.db.prepare(
      `SELECT status, ${turnOwnerColumn} AS turnOwner,
              json_extract(payload, '$.metadata.${SESSION_TITLE_METADATA_KEY}') AS title
       FROM sessions WHERE id = ?`,
    );
    this.selectStoredBareStmt = this.db.prepare(
      `SELECT status, ${turnOwnerColumn} AS turnOwner FROM sessions WHERE id = ?`,
    );
    this.listByWorkingDirStmt = this.db.prepare(
      `SELECT status, payload FROM sessions WHERE working_dir = ? ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentStmt = this.db.prepare(
      `SELECT status, payload FROM sessions ORDER BY updated_at DESC LIMIT ?`,
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
   * no title does not remove one. Nothing renames a session today —
   * `shouldNameSession` refuses to name a session twice — so "keep what
   * is there" is also the product behaviour.
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
  beginTurn(id: string, now: number = Date.now()): boolean {
    if (this.marks === null) return false;
    const owner = serializeTurnOwner(
      turnOwnerFor(this.turnOwnerProbe, now, this.dbIdentity),
    );
    const result = this.marks.begin.run({ id, owner }) as {
      changes: number;
    };
    if (result.changes === 0) return false;
    this.ownTurns.set(id, owner);
    return true;
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
    const stored = this.storedRow(state.id);
    const status = endsTurn
      ? state.status
      : statusForSave(state.status, stored);
    let next: SessionState =
      status === state.status ? state : { ...state, status };
    if (stored === undefined) {
      this.insertStmt.run(this.serialize(next));
      return;
    }
    if (stored.title !== null && readSessionTitle(next.metadata) === null) {
      next = {
        ...next,
        metadata: {
          ...next.metadata,
          [SESSION_TITLE_METADATA_KEY]: stored.title,
        },
      };
    }
    const update = endsTurn ? this.finishTurnStmt : this.updateStmt;
    update.run(this.serialize(next));
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
      | { status: string; turnOwner: string | null; title?: unknown }
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
      status: row.status,
      turnOwner: row.turnOwner,
    };
  }

  load(id: string): SessionState | null {
    const row = this.selectStmt.get(id) as StoredPayloadRow | undefined;
    if (!row) return null;
    return this.readPayload(row);
  }

  listByWorkingDir(workingDir: string, limit = 25): SessionState[] {
    const rows = this.listByWorkingDirStmt.all(
      workingDir,
      limit,
    ) as StoredPayloadRow[];
    return this.readPayloads(rows);
  }

  /**
   * Return the most recently updated sessions across all working dirs.
   * Used by the TUI session picker so the operator can jump between
   * ongoing threads from any project root.
   */
  listRecent(limit = 25): SessionState[] {
    const rows = this.listRecentStmt.all(limit) as StoredPayloadRow[];
    return this.readPayloads(rows);
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
    this.deleteStmt.run(id);
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
  private readPayload(row: StoredPayloadRow): SessionState | null {
    let state: SessionState;
    try {
      state = normalizeSessionState(JSON.parse(row.payload));
    } catch {
      this.unreadableSkips += 1;
      return null;
    }
    return typeof row.status === "string"
      ? { ...state, status: row.status as SessionStatus }
      : state;
  }

  private readPayloads(rows: StoredPayloadRow[]): SessionState[] {
    const states: SessionState[] = [];
    for (const row of rows) {
      const state = this.readPayload(row);
      if (state) states.push(state);
    }
    return states;
  }

  private serialize(state: SessionState): Record<string, unknown> {
    const persistable = stripEphemeral(state);
    return {
      id: persistable.id,
      working_dir: persistable.workingDir,
      status: persistable.status,
      payload: JSON.stringify(persistable),
      created_at: persistable.createdAt,
      updated_at: persistable.updatedAt,
    };
  }
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
 * The real path of the database file, which every mark written into it
 * carries: a mark found in another file came with a copy. `undefined`
 * for an in-memory database, which nothing else can open.
 */
function databaseIdentity(file: string): string | undefined {
  if (file === ":memory:" || file.length === 0) return undefined;
  try {
    return realpathSync.native(file);
  } catch {
    return resolve(file);
  }
}
