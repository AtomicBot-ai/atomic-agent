import type Database from "better-sqlite3";

/**
 * Memory-v2 phase 7a. ExpeL-style vote curation store.
 *
 * Three responsibilities, each backed by a single SQL statement set
 * so the hot path is one round-trip per operation:
 *
 *   1. `applyVote(input)` — atomically loads the current
 *      `vote_score` for the targeted row, computes the new score
 *      under the configured clamp, applies the update, and writes a
 *      single audit row into `vote_events`. Every write happens
 *      inside one transaction so a process crash mid-call cannot
 *      leave a score updated but the audit row absent (or vice
 *      versa).
 *
 *   2. `decayAllScores(factor)` — multiplies every `vote_score`
 *      across `memories` / `lessons` / `profile_facts` by `factor`
 *      using **three bulk SQL UPDATEs** wrapped in one transaction.
 *      No per-row JS round-trip — cross-phase invariant 17 from
 *      MEMORY_FABRIC_V2.md §13.7.7. The consolidator calls this
 *      once per tick; the hot path (per-turn) never decays.
 *
 *   3. `evictOldestEvents(maxRows)` — FIFO cap on the audit log.
 *      Run lazily from `applyVote` when `eventLogMaxRows > 0` and
 *      the row count exceeds the cap; deletes the oldest rows by
 *      `(created_at ASC, id ASC)`. The audit log is bounded to
 *      `memory.voting.eventLogMaxRows` rows (default 50k); set
 *      to 0 to disable eviction entirely.
 *
 * The store does **not** own any cross-table FK constraints: a
 * memory/lesson/profile can be evicted (phase 1A) or deprecated
 * (phase 6) while the audit log keeps remembering the vote
 * happened. `target_id` is intentionally a soft pointer; callers
 * who care about referential integrity must take a snapshot before
 * the eviction sweep.
 */

export type VoteKind = "memory" | "lesson" | "profile" | "procedure";

export const VOTE_KINDS: readonly VoteKind[] = [
  "memory",
  "lesson",
  "profile",
  "procedure",
] as const;

export function isVoteKind(raw: string): raw is VoteKind {
  return (VOTE_KINDS as readonly string[]).includes(raw);
}

/** `+1` for upvote, `-1` for downvote. The grammar never produces
 * any other magnitude. */
export type VoteDirection = 1 | -1;

export class VoteValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "VoteValidationError";
  }
}

export interface ApplyVoteInput {
  kind: VoteKind;
  targetId: number;
  direction: VoteDirection;
  /** Hard ceiling on `|vote_score|` for the targeted row. Must be > 0. */
  maxVotePerItem: number;
  /** Optional audit metadata propagated into `vote_events`. */
  sessionId?: string | null;
  /** Optional 0-based turn counter in the originating session. */
  turnIndex?: number | null;
  /** When > 0, FIFO-evict the audit log down to `eventLogMaxRows`. */
  eventLogMaxRows?: number;
}

export type ApplyVoteResult =
  | {
      status: "applied";
      newScore: number;
      previousScore: number;
      eventId: number;
    }
  | {
      status: "clamp_hit";
      currentScore: number;
    }
  | {
      status: "target_missing";
      kind: VoteKind;
      targetId: number;
    };

export interface VoteEventRow {
  id: number;
  kind: VoteKind;
  targetId: number;
  direction: VoteDirection;
  sessionId: string | null;
  turnIndex: number | null;
  createdAt: number;
}

export interface DecayResult {
  /** Number of memory rows updated by the bulk UPDATE. */
  memories: number;
  lessons: number;
  profileFacts: number;
  /** Phase 7b — procedures decay rows. `0` when the schema is
   * pre-v10 (procedures table missing). */
  procedures: number;
}

export interface VoteStoreOptions {
  db: Database.Database;
  /** Defaults to `Date.now`. Injectable for deterministic tests. */
  now?: () => number;
}

// `kind` is part of the public API surface; the table lookup is the
// only place where it materially leaks into SQL. Keeping the map
// here means the rest of the file can treat `kind` as opaque.
// Exported (rather than file-local) so cross-module callers — e.g.
// the bootstrap allowlist provider — can derive table names from
// the same source of truth without duplicating the mapping.
export const TABLE_BY_KIND: Record<VoteKind, string> = {
  memory: "memories",
  lesson: "lessons",
  profile: "profile_facts",
  procedure: "procedures",
};

export class VoteStore {
  private readonly db: Database.Database;
  private readonly nowFn: () => number;

  // Per-kind prepared statements. We keep three sets instead of one
  // parameterised query because better-sqlite3 cannot bind table
  // names — they have to be baked into the prepared SQL.
  private readonly readScoreByKind: Record<
    VoteKind,
    Database.Statement<{ id: number }>
  >;
  private readonly updateScoreByKind: Record<
    VoteKind,
    Database.Statement<{ id: number; score: number }>
  >;
  private readonly decayByKind: Record<
    VoteKind,
    Database.Statement<{ factor: number }>
  >;

  private readonly insertEvent: Database.Statement<{
    kind: VoteKind;
    targetId: number;
    direction: VoteDirection;
    sessionId: string | null;
    turnIndex: number | null;
    createdAt: number;
  }>;

  private readonly countEvents: Database.Statement<[]>;
  private readonly evictEvents: Database.Statement<{ limit: number }>;

  constructor(opts: VoteStoreOptions) {
    this.db = opts.db;
    this.nowFn = opts.now ?? (() => Date.now());

    this.readScoreByKind = {
      memory: this.db.prepare<{ id: number }>(
        `SELECT vote_score AS score FROM memories WHERE id = @id`,
      ),
      lesson: this.db.prepare<{ id: number }>(
        `SELECT vote_score AS score FROM lessons WHERE id = @id`,
      ),
      profile: this.db.prepare<{ id: number }>(
        `SELECT vote_score AS score FROM profile_facts WHERE id = @id`,
      ),
      procedure: this.db.prepare<{ id: number }>(
        `SELECT vote_score AS score FROM procedures WHERE id = @id`,
      ),
    };
    this.updateScoreByKind = {
      memory: this.db.prepare<{ id: number; score: number }>(
        `UPDATE memories SET vote_score = @score WHERE id = @id`,
      ),
      lesson: this.db.prepare<{ id: number; score: number }>(
        `UPDATE lessons SET vote_score = @score WHERE id = @id`,
      ),
      profile: this.db.prepare<{ id: number; score: number }>(
        `UPDATE profile_facts SET vote_score = @score WHERE id = @id`,
      ),
      procedure: this.db.prepare<{ id: number; score: number }>(
        `UPDATE procedures SET vote_score = @score WHERE id = @id`,
      ),
    };
    this.decayByKind = {
      memory: this.db.prepare<{ factor: number }>(
        `UPDATE memories SET vote_score = vote_score * @factor WHERE vote_score != 0`,
      ),
      lesson: this.db.prepare<{ factor: number }>(
        `UPDATE lessons SET vote_score = vote_score * @factor WHERE vote_score != 0`,
      ),
      profile: this.db.prepare<{ factor: number }>(
        `UPDATE profile_facts SET vote_score = vote_score * @factor WHERE vote_score != 0`,
      ),
      procedure: this.db.prepare<{ factor: number }>(
        `UPDATE procedures SET vote_score = vote_score * @factor WHERE vote_score != 0`,
      ),
    };

    this.insertEvent = this.db.prepare(
      `INSERT INTO vote_events
         (kind, target_id, direction, session_id, turn_index, created_at)
       VALUES (@kind, @targetId, @direction, @sessionId, @turnIndex, @createdAt)`,
    );

    this.countEvents = this.db.prepare<[]>(
      `SELECT COUNT(*) AS c FROM vote_events`,
    );
    this.evictEvents = this.db.prepare<{ limit: number }>(
      `DELETE FROM vote_events
         WHERE id IN (
           SELECT id FROM vote_events
            ORDER BY created_at ASC, id ASC
            LIMIT @limit
         )`,
    );
  }

  /** Inspect the current `vote_score` for a (kind, id) pair. Returns
   * `null` when the row does not exist. Pure read; no audit. */
  getScore(kind: VoteKind, targetId: number): number | null {
    const row = this.readScoreByKind[kind].get({ id: targetId }) as
      | { score: number }
      | undefined;
    return row ? row.score : null;
  }

  /** Number of audit rows currently in `vote_events`. */
  getEventCount(): number {
    const row = this.countEvents.get() as { c: number };
    return row.c;
  }

  /** List audit events newest-first. Test / inspection helper —
   * production code should not iterate the full log. */
  listEvents(opts: { limit?: number } = {}): VoteEventRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 10_000));
    const rows = this.db
      .prepare(
        `SELECT id, kind, target_id AS targetId, direction,
                session_id AS sessionId, turn_index AS turnIndex,
                created_at AS createdAt
           FROM vote_events
           ORDER BY id DESC
           LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      kind: string;
      targetId: number;
      direction: number;
      sessionId: string | null;
      turnIndex: number | null;
      createdAt: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as VoteKind,
      targetId: r.targetId,
      direction: r.direction === -1 ? -1 : 1,
      sessionId: r.sessionId,
      turnIndex: r.turnIndex,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Apply a single vote. Atomic — the score update and audit row
   * live in one transaction so partial state is impossible.
   *
   * Returns `{ status: "target_missing" }` when the target row does
   * not exist (eviction race, malformed allowlist), `clamp_hit`
   * when the score is already pinned at the clamp, and `applied`
   * otherwise.
   */
  applyVote(input: ApplyVoteInput): ApplyVoteResult {
    this.validateInput(input);
    const {
      kind,
      targetId,
      direction,
      maxVotePerItem,
      sessionId = null,
      turnIndex = null,
      eventLogMaxRows = 0,
    } = input;

    const apply = this.db.transaction((): ApplyVoteResult => {
      const current = this.getScore(kind, targetId);
      if (current === null) {
        return { status: "target_missing", kind, targetId };
      }
      const clamp = Math.abs(maxVotePerItem);
      const proposed = current + direction;
      const newScore = Math.max(-clamp, Math.min(clamp, proposed));
      if (newScore === current) {
        return { status: "clamp_hit", currentScore: current };
      }
      this.updateScoreByKind[kind].run({ id: targetId, score: newScore });
      const info = this.insertEvent.run({
        kind,
        targetId,
        direction,
        sessionId,
        turnIndex,
        createdAt: this.nowFn(),
      });
      // `lastInsertRowid` is `number | bigint` depending on driver
      // build; we treat values that fit in `Number.MAX_SAFE_INTEGER`
      // as `number`. The audit table is FIFO-capped at 50k by
      // default so we will never approach the bigint range in
      // practice; the fallback exists for paranoid future-proofing.
      const eventId =
        typeof info.lastInsertRowid === "bigint"
          ? Number(info.lastInsertRowid)
          : (info.lastInsertRowid as number);
      return {
        status: "applied",
        newScore,
        previousScore: current,
        eventId,
      };
    });

    const result = apply();

    if (eventLogMaxRows > 0 && result.status === "applied") {
      this.evictOldestEvents(eventLogMaxRows);
    }
    return result;
  }

  /**
   * Cold-path scaling of every `vote_score` value by `factor`. Runs
   * three bulk UPDATEs in one transaction — no per-row JS code path
   * (cross-phase invariant 17). Returns the number of rows touched
   * by each UPDATE (for the `agent.memory.voting.decayed` metric).
   *
   * `factor` is expected to be in `(0, 1]`; the bootstrap config
   * validator already rejects out-of-range values, but the store
   * defensively clamps to `[0, 1]` because the call site is a
   * scheduled job that should never crash on a misconfigured value.
   */
  decayAllScores(factor: number): DecayResult {
    const clamped = Math.max(0, Math.min(1, factor));
    const decay = this.db.transaction((): DecayResult => {
      const memInfo = this.decayByKind.memory.run({ factor: clamped });
      const lessonInfo = this.decayByKind.lesson.run({ factor: clamped });
      const profileInfo = this.decayByKind.profile.run({ factor: clamped });
      const procInfo = this.decayByKind.procedure.run({ factor: clamped });
      return {
        memories: memInfo.changes,
        lessons: lessonInfo.changes,
        profileFacts: profileInfo.changes,
        procedures: procInfo.changes,
      };
    });
    return decay();
  }

  /**
   * FIFO-evict audit rows down to `maxRows`. Idempotent: when the
   * current count already fits inside the cap, this is a no-op.
   *
   * `maxRows = 0` is the "disable eviction" sentinel — the call
   * returns 0 without touching the table. Callers should not invoke
   * with negative values; the method clamps defensively.
   */
  evictOldestEvents(maxRows: number): number {
    const cap = Math.max(0, Math.floor(maxRows));
    if (cap === 0) return 0;
    const count = this.getEventCount();
    if (count <= cap) return 0;
    const limit = count - cap;
    const info = this.evictEvents.run({ limit });
    return info.changes;
  }

  private validateInput(input: ApplyVoteInput): void {
    if (!isVoteKind(input.kind)) {
      throw new VoteValidationError(
        "kind",
        `kind: unknown vote kind ${JSON.stringify(input.kind)}`,
      );
    }
    if (!Number.isInteger(input.targetId) || input.targetId <= 0) {
      throw new VoteValidationError(
        "targetId",
        `targetId: expected positive integer id, got ${JSON.stringify(input.targetId)}`,
      );
    }
    if (input.direction !== 1 && input.direction !== -1) {
      throw new VoteValidationError(
        "direction",
        `direction: expected +1 or -1, got ${JSON.stringify(input.direction)}`,
      );
    }
    if (
      !Number.isInteger(input.maxVotePerItem) ||
      input.maxVotePerItem <= 0
    ) {
      throw new VoteValidationError(
        "maxVotePerItem",
        `maxVotePerItem: expected positive integer, got ${JSON.stringify(input.maxVotePerItem)}`,
      );
    }
  }
}
