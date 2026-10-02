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
  readSessionTitle,
} from "./session-title.js";
import {
  currentTurnOwnerProbe,
  isTurnOwnerGone,
  serializeTurnOwner,
  type TurnOwnerProbe,
} from "./turn-owner.js";

// `turn_owner` is null except while a turn is running on the row (see
// `beginTurn`). Databases made before it existed get it from
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

/**
 * The payload carries its own copy of `status` (and `lastError`), which
 * is what `load` hands back; the status-only writes below keep it in
 * step with the column. A payload that is not JSON is left alone — no
 * reader can parse it anyway — and the column still moves.
 */
const SET_STATUS_SQL = `status = @status,
       payload = CASE WHEN json_valid(payload)
                      THEN json_set(payload,
                                    '$.status', @status,
                                    '$.lastError', COALESCE(@last_error, json_extract(payload, '$.lastError')))
                      ELSE payload END,
       turn_owner = NULL`;

/**
 * How a turn that could not write its own end is recorded instead: the
 * status it ends on, and the sentence `lastError` carries (`null` keeps
 * whatever the row already had).
 */
export interface TurnEnding {
  readonly status: SessionStatus;
  readonly lastError?: string | null;
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
  private readonly selectTitleStmt: Database.Statement;
  private readonly listByWorkingDirStmt: Database.Statement;
  private readonly listRecentStmt: Database.Statement;
  private readonly listRecentDirsStmt: Database.Statement;
  private readonly summaryFirstPageStmt: Database.Statement;
  private readonly summaryNextPageStmt: Database.Statement;
  private readonly countUnreadableStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly beginTurnStmt: Database.Statement;
  private readonly finishTurnStmt: Database.Statement;
  private readonly releaseTurnStmt: Database.Statement;
  private readonly listLiveTurnsStmt: Database.Statement;
  private readonly recoverTurnStmt: Database.Statement;
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
    this.db = new DatabaseCtor(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    ensureTurnOwnerColumn(this.db);
    this.turnOwnerProbe = options.turnOwnerProbe ?? currentTurnOwnerProbe();
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
    this.selectStmt = this.db.prepare(
      `SELECT payload FROM sessions WHERE id = ?`,
    );
    // Projected in SQL rather than parsed in JS: `save` runs this on
    // every write, and a transcript payload is the one thing in this
    // row worth not re-parsing.
    this.selectTitleStmt = this.db.prepare(
      `SELECT json_extract(payload, '$.metadata.${SESSION_TITLE_METADATA_KEY}') AS title
       FROM sessions WHERE id = ?`,
    );
    this.listByWorkingDirStmt = this.db.prepare(
      `SELECT payload FROM sessions WHERE working_dir = ? ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listRecentStmt = this.db.prepare(
      `SELECT payload FROM sessions ORDER BY updated_at DESC LIMIT ?`,
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
    // `updated_at` is left alone: the row's content has not changed, and
    // it is what every list orders by and the desktop reads "unread" from.
    this.beginTurnStmt = this.db.prepare(
      `UPDATE sessions
       SET status = 'running',
           payload = CASE WHEN json_valid(payload)
                          THEN json_set(payload, '$.status', 'running')
                          ELSE payload END,
           turn_owner = @owner
       WHERE id = @id`,
    );
    this.finishTurnStmt = this.db.prepare(
      `UPDATE sessions
       SET working_dir = @working_dir,
           status = @status,
           payload = @payload,
           updated_at = @updated_at,
           turn_owner = NULL
       WHERE id = @id`,
    );
    this.releaseTurnStmt = this.db.prepare(
      `UPDATE sessions
       SET ${SET_STATUS_SQL}
       WHERE id = @id AND turn_owner IS @owner`,
    );
    // By status, not by mark: `idx_sessions_status` keeps this to the
    // few rows that claim a live turn, and reading `turn_owner` — stored
    // after the payload — on every row would read every transcript.
    this.listLiveTurnsStmt = this.db.prepare(
      `SELECT id, status, turn_owner AS turnOwner
       FROM sessions WHERE status IN (${LIVE_STATUS_SQL_LIST})`,
    );
    // Guarded on what the sweep read, so a turn another process started
    // on the row in between keeps its mark.
    this.recoverTurnStmt = this.db.prepare(
      `UPDATE sessions
       SET ${SET_STATUS_SQL}
       WHERE id = @id AND status = @read_status AND turn_owner IS @owner`,
    );
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
   * `save` never touches a turn's mark (`beginTurn`): only the turn's
   * own end — `finishTurn` or `releaseTurn` — takes it off.
   */
  save(state: SessionState): void {
    this.write(state, this.updateStmt);
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
    const owner = serializeTurnOwner({
      pid: this.turnOwnerProbe.pid,
      bootAt: this.turnOwnerProbe.bootAt,
      at: now,
    });
    const result = this.beginTurnStmt.run({ id, owner }) as {
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
   */
  finishTurn(state: SessionState): void {
    try {
      this.write(state, this.finishTurnStmt);
    } finally {
      this.ownTurns.delete(state.id);
    }
  }

  /**
   * End a turn this store marked without the state it ended with — it
   * threw, or the runtime is closing under it — by writing `ending` as
   * its status. Touches the row only while it still carries this store's
   * own mark: a turn that wrote its end already, or one another process
   * has since started on the row, is left as it is. Returns whether the
   * row was changed.
   */
  releaseTurn(id: string, ending: TurnEnding): boolean {
    const owner = this.ownTurns.get(id);
    if (owner === undefined) return false;
    try {
      const result = this.releaseTurnStmt.run({
        id,
        owner,
        status: ending.status,
        last_error: ending.lastError ?? null,
      }) as { changes: number };
      return result.changes > 0;
    } finally {
      this.ownTurns.delete(id);
    }
  }

  /**
   * `releaseTurn` for every turn this store still has marked. For
   * shutdown: the store is about to close, and a turn that has not
   * written its end by now never will. Returns how many rows changed.
   */
  releaseOwnTurns(ending: TurnEnding): number {
    let released = 0;
    for (const id of [...this.ownTurns.keys()]) {
      if (this.releaseTurn(id, ending)) released += 1;
    }
    return released;
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
   * turn (see there). Returns the ids it ended.
   */
  recoverInterruptedTurns(
    options: {
      isOwnerGone?: (owner: string | null) => boolean;
      ending?: TurnEnding;
    } = {},
  ): string[] {
    const probe = this.turnOwnerProbe;
    const isOwnerGone: (owner: string | null) => boolean =
      options.isOwnerGone ?? ((owner) => isTurnOwnerGone(owner, probe));
    const ending = options.ending ?? INTERRUPTED_TURN_ENDING;
    const sweep = this.db.transaction((): string[] => {
      const rows = this.listLiveTurnsStmt.all() as Array<{
        id: string;
        status: string;
        turnOwner: string | null;
      }>;
      const recovered: string[] = [];
      for (const row of rows) {
        if (this.ownTurns.has(row.id)) continue;
        if (!isOwnerGone(row.turnOwner)) continue;
        const result = this.recoverTurnStmt.run({
          id: row.id,
          read_status: row.status,
          owner: row.turnOwner,
          status: ending.status,
          last_error: ending.lastError ?? null,
        }) as { changes: number };
        if (result.changes > 0) recovered.push(row.id);
      }
      return recovered;
    });
    return sweep();
  }

  private write(state: SessionState, update: Database.Statement): void {
    const stored = this.storedTitle(state.id);
    if (stored === undefined) {
      this.insertStmt.run(this.serialize(state));
      return;
    }
    const keep = stored !== null && readSessionTitle(state.metadata) === null;
    update.run(
      this.serialize(
        keep
          ? {
              ...state,
              metadata: {
                ...state.metadata,
                [SESSION_TITLE_METADATA_KEY]: stored,
              },
            }
          : state,
      ),
    );
  }

  /**
   * The stored title: `undefined` when there is no such row, `null`
   * when the row has no title.
   *
   * `json_extract` raises on a payload that is not valid JSON, and this
   * table tolerates those (see `countUnreadable`) — a corrupt row must
   * not make saving impossible, so it falls back to the existence check
   * `save` did before.
   */
  private storedTitle(id: string): string | null | undefined {
    try {
      const row = this.selectTitleStmt.get(id) as
        | { title: string | null }
        | undefined;
      if (row === undefined) return undefined;
      return typeof row.title === "string" && row.title.trim().length > 0
        ? row.title
        : null;
    } catch {
      return this.selectStmt.get(id) === undefined ? undefined : null;
    }
  }

  load(id: string): SessionState | null {
    const row = this.selectStmt.get(id) as { payload: string } | undefined;
    if (!row) return null;
    return this.readPayload(row);
  }

  listByWorkingDir(workingDir: string, limit = 25): SessionState[] {
    const rows = this.listByWorkingDirStmt.all(workingDir, limit) as Array<{
      payload: string;
    }>;
    return this.readPayloads(rows);
  }

  /**
   * Return the most recently updated sessions across all working dirs.
   * Used by the TUI session picker so the operator can jump between
   * ongoing threads from any project root.
   */
  listRecent(limit = 25): SessionState[] {
    const rows = this.listRecentStmt.all(limit) as Array<{ payload: string }>;
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
   */
  private readPayload(row: { payload: string }): SessionState | null {
    try {
      return normalizeSessionState(JSON.parse(row.payload));
    } catch {
      this.unreadableSkips += 1;
      return null;
    }
  }

  private readPayloads(rows: Array<{ payload: string }>): SessionState[] {
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
 */
function ensureTurnOwnerColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "turn_owner")) return;
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN turn_owner TEXT`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(message)) throw err;
  }
}
