import type Database from "better-sqlite3";

/**
 * ATO-2506. The consolidator's own durable state, kept in `memory.sqlite`
 * next to the notes it is about, so it survives a restart (the job ticks
 * every few hours; an in-memory map would be lost long before it helped).
 *
 * Two pieces:
 *
 *   - **Abstain backoff** on note rows (`consolidation_abstains`,
 *     `consolidation_retry_at`, see ../consolidation-backoff-columns.ts).
 *     When the model abstains from a cluster, its notes are put off:
 *     first abstain one `baseMs`, each further abstain doubles the wait,
 *     capped at `maxMs`. Same shape as the link-generator timeout backoff
 *     (../links/link-generator-backoff.ts), but persisted. Timeouts and
 *     failures do not touch it: those clusters retry on the next tick.
 *   - **Candidate page cursor** (one `schema_meta` row): the last note of
 *     the previous tick's candidate page, so the next tick reads the page
 *     after it and older notes are reached over ticks.
 *
 * Bounded: two nullable columns per note and one meta row; no table grows.
 */
export interface ConsolidationCursor {
  updatedAt: number;
  id: number;
}

export interface AbstainBackoffPolicy {
  /** Wait after the first abstain. */
  baseMs: number;
  /** Upper bound for the doubled wait. */
  maxMs: number;
}

export interface NoteBackoff {
  abstains: number;
  retryAt: number;
}

/** Abstain counter cap; also keeps `2 ** n` finite. */
export const MAX_COUNTED_ABSTAINS = 30;

const CURSOR_KEY = "consolidator_cursor";

/** Wait before the next try after `abstains` abstains in a row (>= 1). */
export function abstainBackoffMs(
  abstains: number,
  policy: AbstainBackoffPolicy,
): number {
  const base = Math.max(0, policy.baseMs);
  const max = Math.max(base, policy.maxMs);
  const exponent = Math.min(Math.max(1, abstains), MAX_COUNTED_ABSTAINS) - 1;
  return Math.min(max, base * 2 ** exponent);
}

export class ConsolidationStateStore {
  private readonly db: Database.Database;

  constructor(deps: { db: Database.Database }) {
    this.db = deps.db;
  }

  /**
   * Put off every still-active note of an abstained cluster. Returns how
   * many rows were deferred (archived or missing ids are skipped).
   */
  deferAbstained(
    ids: readonly number[],
    now: number,
    policy: AbstainBackoffPolicy,
  ): number {
    if (ids.length === 0) return 0;
    const read = this.db.prepare(
      `SELECT consolidation_abstains AS abstains FROM memories
        WHERE id = ? AND consolidated_into IS NULL`,
    );
    const write = this.db.prepare(
      `UPDATE memories
          SET consolidation_abstains = ?, consolidation_retry_at = ?
        WHERE id = ?`,
    );
    const txn = this.db.transaction((): number => {
      let deferred = 0;
      for (const id of ids) {
        const row = read.get(id) as { abstains: number | null } | undefined;
        if (!row) continue;
        const abstains = Math.min((row.abstains ?? 0) + 1, MAX_COUNTED_ABSTAINS);
        write.run(abstains, now + abstainBackoffMs(abstains, policy), id);
        deferred += 1;
      }
      return deferred;
    });
    return txn();
  }

  getBackoff(id: number): NoteBackoff | null {
    const row = this.db
      .prepare(
        `SELECT consolidation_abstains AS abstains,
                consolidation_retry_at AS retryAt
           FROM memories WHERE id = ?`,
      )
      .get(id) as { abstains: number | null; retryAt: number | null } | undefined;
    if (!row || row.abstains === null || row.retryAt === null) return null;
    return { abstains: row.abstains, retryAt: row.retryAt };
  }

  readCursor(): ConsolidationCursor | null {
    const row = this.db
      .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
      .get(CURSOR_KEY) as { value: string } | undefined;
    if (!row) return null;
    const match = /^(-?\d+):(\d+)$/.exec(row.value);
    if (!match) return null;
    const updatedAt = Number(match[1]);
    const id = Number(match[2]);
    if (!Number.isSafeInteger(updatedAt) || !Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    return { updatedAt, id };
  }

  /** `null` clears it: the next tick starts again from the newest notes. */
  writeCursor(cursor: ConsolidationCursor | null): void {
    if (cursor === null) {
      this.db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(CURSOR_KEY);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(CURSOR_KEY, `${Math.trunc(cursor.updatedAt)}:${cursor.id}`);
  }
}
