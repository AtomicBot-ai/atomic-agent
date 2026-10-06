import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMetrics } from "../tracing/agent-metrics.js";

import { applyMigrations } from "./memory-schema.js";
import {
  isNameGroundingStatus,
  isNameProfileKey,
  isProfileFactPromptVisible,
  type NameGroundingStatus,
} from "./profile-name-keys.js";
import {
  assertProfileMaxEntries,
  ProfileEvictor,
  type ProfileEviction,
} from "./profile-eviction.js";

// TODO(memory-v2 phase 7a): add `vote_score REAL` column (clamped to
// `±memory.voting.maxVotePerItem`); expose `applyVote(key, delta)`,
// `applyEdit(key, patch)`, `decayScores(factor)` invoked from the
// consolidator tick (§9 invariant 23). All three through the same
// validators used by `set()`.

export interface ProfileFact {
  /**
   * Memory-v2 phase 4. Stable row identity for the bi-temporal table.
   * Older callers that only need `(key, value, updatedAt, pinned,
   * keywords)` continue to compile because every legacy field stays
   * shaped the same; `id`, `validFrom`, `supersedes` are additive.
   */
  id: number;
  key: string;
  value: string;
  /**
   * Wall-clock ms the row became authoritative. For an `active`
   * row this is when `set()` wrote it; for a superseded row it is
   * unchanged from when it was originally written.
   */
  validFrom: number;
  /**
   * Wall-clock ms the row was last touched in any way. For phase 4
   * this is identical to `validFrom` because every write creates a
   * fresh row — the column is kept so phase 7a can stamp `applyVote`
   * timestamps without another migration.
   */
  updatedAt: number;
  /**
   * Pinned facts are always rendered into `### profile`. Contextual
   * facts (pinned=false) only appear when the renderer finds at least
   * one of their `keywords` in the current user message. Defaults to
   * `true` so back-compat matches the old "always-render" behaviour.
   */
  pinned: boolean;
  /**
   * Contextual-gate keywords. Matched case-insensitively as whole-word
   * substrings against the user message by `profile-renderer`. Only
   * meaningful when `pinned=false`; kept as `[]` for pinned facts.
   */
  keywords: string[];
  /**
   * Memory-v2 phase 4. `id` of the row this one replaces. NULL when
   * this is the first version for the key. Soft pointer (no FK
   * constraint) so `remove()` of an active row never cascades into
   * the historical chain.
   */
  supersedes: number | null;
  /**
   * Memory-v2 phase 4. `id` of the row that replaced this one. NULL
   * for the **active** row of a key; non-NULL means the row is
   * historical and excluded from `list()` / `get()`.
   */
  supersededBy: number | null;
  /**
   * Memory-v2 phase 7a. Aggregated curation signal clamped to
   * `±memory.voting.maxVotePerItem`. Decays once per consolidator
   * tick. Defaults to `0` for any row migrated from a v8 database.
   * The profile renderer hides facts with
   * `vote_score ≤ -profileFilterThreshold`.
   */
  voteScore: number;
  /**
   * ATO-199. For a name-like key (`isNameProfileKey`): whether the
   * user's own messages carry this name — see `NameGroundingStatus`.
   * `null` = not checked yet, and always `null` for any other key.
   * Optional so hand-built facts (tests, fixtures) keep compiling; the
   * store always fills it.
   */
  nameGrounding?: NameGroundingStatus | null;
}

/** An active name-like fact the startup check still has to look at. */
export interface ProfileNameFactToCheck {
  fact: ProfileFact;
  /**
   * When the fact was last checked (`ungrounded` rows), or `null` when
   * it never was. A re-check only needs sessions written after it.
   */
  checkedAt: number | null;
}

export interface ProfileStoreOptions {
  dbFile: string;
  /**
   * Memory-v2 phase 4. Optional metrics sink for
   * `agent.memory.profile.superseded`. The store still functions
   * correctly without it; only observability degrades.
   */
  metrics?: AgentMetrics;
  /**
   * Issue #407. Cap on active **unpinned** facts
   * (`memory.profile.maxEntries`). Omitted ⇒ no cap. Pinned facts are
   * never counted and never evicted — see `ProfileEvictor`.
   */
  maxEntries?: number;
  /**
   * Called after a `set()` that evicted facts has committed. Fire-safe:
   * a throwing listener never fails the write that triggered it.
   */
  onEvicted?: (eviction: ProfileEviction) => void;
}

export interface ProfileSetOptions {
  pinned?: boolean;
  keywords?: string[];
  /**
   * Memory-v2 phase 4. Cross-key supersession hint. When provided,
   * marks the active row for `supersedesKey` as superseded by the
   * new row even though their `key` columns differ. Most reflection-
   * driven writes leave this `undefined` — same-key writes already
   * auto-chain via the `idx_profile_active_key` partial unique
   * index. Use this when the LLM emits e.g.
   * `SET full_name=Alex [supersedes=name]`.
   */
  supersedesKey?: string;
  /**
   * ATO-199. Grounding status of the written value, for a name-like key
   * only (ignored for any other key). The caller that checked the value
   * against the user's messages passes the verdict; omitted ⇒ the row
   * lands unchecked and stays out of the prompt until the startup check
   * looks at it.
   */
  nameGrounding?: NameGroundingStatus;
}

/**
 * Maximum length of a single profile value. Guards against the LLM
 * pasting an entire document into `memory.profile.set`. Values longer
 * than this are rejected at write time rather than silently truncated
 * so the tool result explicitly fails.
 */
export const PROFILE_VALUE_MAX_LENGTH = 2_000;

/** Maximum length of a profile key. Matches the free-form identifier convention. */
export const PROFILE_KEY_MAX_LENGTH = 120;

/** Max keywords per contextual fact. */
export const PROFILE_KEYWORDS_MAX = 8;
/** Max length per keyword. */
export const PROFILE_KEYWORD_MAX_LENGTH = 40;

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;

interface ProfileRow {
  id: number;
  key: string;
  value: string;
  pinned: number;
  keywords: string | null;
  valid_from: number;
  superseded_by: number | null;
  supersedes: number | null;
  created_at: number;
  updated_at: number;
  vote_score: number;
  name_grounding: string | null;
  name_checked_at: number | null;
}

/**
 * Durable key/value store for user profile facts. After memory-v2
 * phase 4 every write produces a **new row**; the previous active
 * row for the same key (if any) is marked `superseded_by = newId`
 * in the same transaction. `list()` / `get()` filter to active rows
 * only; `history(key)` walks the full chain in temporal order.
 *
 * All methods are synchronous because the volume is tiny (typically
 * under 50 active rows) and `better-sqlite3` is already synchronous.
 */
export class ProfileStore {
  private readonly db: Database.Database;
  private readonly metrics: AgentMetrics | undefined;
  private readonly evictor: ProfileEvictor | null;
  private readonly onEvicted:
    | ((eviction: ProfileEviction) => void)
    | undefined;
  private readonly insertStmt: Database.Statement;
  private readonly markSupersededStmt: Database.Statement;
  private readonly preflipParentStmt!: Database.Statement;
  private readonly selectActiveByKeyStmt: Database.Statement;
  private readonly selectActiveByIdStmt: Database.Statement;
  private readonly selectAllActiveStmt: Database.Statement;
  private readonly historyByKeyStmt: Database.Statement;
  private readonly deleteActiveStmt: Database.Statement;
  private readonly markNameGroundingStmt: Database.Statement;
  private readonly markUnconfirmedNameGroundingStmt: Database.Statement;

  constructor(options: ProfileStoreOptions) {
    // Before the handle opens, so a bad cap cannot leak a connection.
    if (options.maxEntries !== undefined) {
      assertProfileMaxEntries(options.maxEntries);
    }
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    applyMigrations(this.db);
    this.metrics = options.metrics;
    this.evictor =
      options.maxEntries !== undefined
        ? new ProfileEvictor(this.db, options.maxEntries)
        : null;
    this.onEvicted = options.onEvicted;
    this.insertStmt = this.db.prepare(
      `INSERT INTO profile_facts
         (key, value, pinned, keywords, valid_from, superseded_by,
          supersedes, created_at, updated_at, name_grounding,
          name_checked_at)
       VALUES
         (@key, @value, @pinned, @keywords, @valid_from, NULL,
          @supersedes, @created_at, @updated_at, @name_grounding,
          @name_checked_at)`,
    );
    this.markSupersededStmt = this.db.prepare(
      `UPDATE profile_facts
          SET superseded_by = @new_id,
              updated_at = @now
        WHERE id = @id`,
    );
    // Phase 4: SQLite's partial unique index (idx_profile_active_key)
    // is immediate, not deferred. We cannot insert the new row while
    // the parent still has superseded_by IS NULL — both would briefly
    // count as "active" and the constraint would reject. The fix is
    // to flip the parent out of the active set FIRST with a sentinel
    // value (we use the parent's own id — any non-NULL value works;
    // self-pointer is the least surprising payload to see in a row
    // dump), insert the new row, then patch the parent's
    // `superseded_by` to point at the real newId. The intermediate
    // self-pointer is never observed outside the transaction.
    this.preflipParentStmt = this.db.prepare(
      `UPDATE profile_facts
          SET superseded_by = id
        WHERE id = ?`,
    );
    this.selectActiveByKeyStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at,
              vote_score, name_grounding, name_checked_at
         FROM profile_facts
        WHERE key = ? AND superseded_by IS NULL`,
    );
    this.selectActiveByIdStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at,
              vote_score, name_grounding, name_checked_at
         FROM profile_facts
        WHERE id = ?`,
    );
    this.selectAllActiveStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at,
              vote_score, name_grounding, name_checked_at
         FROM profile_facts
        WHERE superseded_by IS NULL
        ORDER BY key ASC`,
    );
    this.historyByKeyStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at,
              vote_score, name_grounding, name_checked_at
         FROM profile_facts
        WHERE key = ?
        ORDER BY valid_from ASC, id ASC`,
    );
    this.deleteActiveStmt = this.db.prepare(
      `DELETE FROM profile_facts
        WHERE key = ? AND superseded_by IS NULL`,
    );
    // Metadata only: `updated_at` is left alone — it orders eviction,
    // and a check is not a write of the fact.
    this.markNameGroundingStmt = this.db.prepare(
      `UPDATE profile_facts
          SET name_grounding = @status,
              name_checked_at = @now
        WHERE id = @id`,
    );
    this.markUnconfirmedNameGroundingStmt = this.db.prepare(
      `UPDATE profile_facts
          SET name_grounding = @status,
              name_checked_at = @now
        WHERE id = @id
          AND (name_grounding IS NULL OR name_grounding = 'ungrounded')`,
    );
  }

  /**
   * Write a new version of a profile fact. Every call inserts a
   * **new row**; the previous active row for the same key (and the
   * `supersedesKey`, if provided) is marked superseded in the same
   * transaction. The transaction guarantees the partial unique index
   * never sees two active rows for a key at the same instant.
   *
   * The legacy 3-arg form `set(key, value, now)` is preserved for
   * back-compat with the reflection runner and assorted tests.
   */
  set(
    key: string,
    value: string,
    optionsOrNow?: ProfileSetOptions | number,
    nowArg?: number,
  ): ProfileFact {
    const normalisedKey = validateKey(key);
    const normalisedValue = validateValue(value);
    const options: ProfileSetOptions =
      typeof optionsOrNow === "object" && optionsOrNow !== null
        ? optionsOrNow
        : {};
    const now =
      typeof optionsOrNow === "number" ? optionsOrNow : (nowArg ?? Date.now());
    const pinned =
      options.pinned === undefined ? true : Boolean(options.pinned);
    const keywords = pinned ? [] : validateKeywords(options.keywords);
    const supersedesKeyRaw = options.supersedesKey;
    const supersedesKey =
      supersedesKeyRaw !== undefined ? validateKey(supersedesKeyRaw) : null;
    const nameGrounding =
      isNameProfileKey(normalisedKey) && options.nameGrounding !== undefined
        ? options.nameGrounding
        : null;

    const txn = this.db.transaction(
      (): {
        id: number;
        supersedes: number | null;
        eviction: ProfileEviction | null;
      } => {
        // Same-key auto-chain: if there is an active row for the
        // incoming key, capture its id so we can flip it after insert.
        const sameKeyActive = this.selectActiveByKeyStmt.get(normalisedKey) as
          ProfileRow | undefined;
        // Cross-key supersession: only fires when `supersedesKey` was
        // provided AND differs from the incoming key (same-key is
        // already handled above).
        const crossKeyActive =
          supersedesKey !== null && supersedesKey !== normalisedKey
            ? (this.selectActiveByKeyStmt.get(supersedesKey) as
                ProfileRow | undefined)
            : undefined;

        // Pick which row this new write supersedes. Same-key wins over
        // cross-key — the parser-emitted `supersedesKey` is more of a
        // hint and the storage layer always honours the structural
        // same-key chain first.
        const directParent = sameKeyActive ?? crossKeyActive ?? null;

        // Flip every soon-to-be-superseded parent out of the active
        // set with a sentinel `superseded_by = id` BEFORE inserting the
        // new row. Without this the partial unique index
        // (`idx_profile_active_key WHERE superseded_by IS NULL`) would
        // reject the insert because two rows would briefly count as
        // active for the same `key`.
        if (sameKeyActive) {
          this.preflipParentStmt.run(sameKeyActive.id);
        }
        if (crossKeyActive && crossKeyActive.id !== (sameKeyActive?.id ?? -1)) {
          this.preflipParentStmt.run(crossKeyActive.id);
        }

        const insertResult = this.insertStmt.run({
          key: normalisedKey,
          value: normalisedValue,
          pinned: pinned ? 1 : 0,
          keywords: keywords.length > 0 ? JSON.stringify(keywords) : null,
          valid_from: now,
          supersedes: directParent ? directParent.id : null,
          created_at: now,
          updated_at: now,
          name_grounding: nameGrounding,
          name_checked_at: nameGrounding !== null ? now : null,
        }) as { lastInsertRowid: number | bigint };
        const newId = Number(insertResult.lastInsertRowid);

        // Flip the parent (and the cross-key sibling, if any).
        if (sameKeyActive) {
          this.markSupersededStmt.run({
            new_id: newId,
            now,
            id: sameKeyActive.id,
          });
        }
        if (crossKeyActive && crossKeyActive.id !== (sameKeyActive?.id ?? -1)) {
          this.markSupersededStmt.run({
            new_id: newId,
            now,
            id: crossKeyActive.id,
          });
        }

        return {
          id: newId,
          supersedes: directParent ? directParent.id : null,
          // Same transaction as the insert: the cap is never observed
          // exceeded, and a write that rolls back evicts nothing.
          eviction: this.evictor?.evictOverflow(newId) ?? null,
        };
      },
    );

    const { id, supersedes, eviction } = txn();
    if (eviction !== null) {
      try {
        this.onEvicted?.(eviction);
      } catch {
        // Observability only: the write has already committed.
      }
    }

    if (supersedes !== null) {
      this.metrics?.recordProfileSuperseded({
        key: normalisedKey,
        previousId: supersedes,
        nextId: id,
      });
    }

    return {
      id,
      key: normalisedKey,
      value: normalisedValue,
      validFrom: now,
      updatedAt: now,
      pinned,
      keywords,
      supersedes,
      supersededBy: null,
      voteScore: 0,
      nameGrounding,
    };
  }

  /**
   * Delete the **active** row for `key`. Historical (superseded)
   * rows are kept on disk — direct chain walks via `history(key)`
   * still work. Returns `true` when a row was deleted.
   */
  remove(key: string): boolean {
    const normalisedKey = validateKey(key);
    const result = this.deleteActiveStmt.run(normalisedKey) as {
      changes: number;
    };
    return result.changes > 0;
  }

  /**
   * Return the active row for `key`, or `null` when no active row
   * exists (either never written, or the active row was removed).
   * Superseded rows are never returned here.
   */
  get(key: string): ProfileFact | null {
    const normalisedKey = validateKey(key);
    const row = this.selectActiveByKeyStmt.get(normalisedKey) as
      ProfileRow | undefined;
    if (!row) return null;
    return rowToFact(row);
  }

  /**
   * Return the row with the given `id` regardless of supersession
   * status. Useful for traversing historical chains and for the
   * `memory.profile.history` tool's pretty-printer.
   */
  getById(id: number): ProfileFact | null {
    const row = this.selectActiveByIdStmt.get(id) as ProfileRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * List every **active** profile fact, ordered by `key ASC`. This
   * is the surface used by the prompt renderer and the live profile
   * snapshot in `agent-loop`.
   */
  list(): ProfileFact[] {
    const rows = this.selectAllActiveStmt.all() as ProfileRow[];
    return rows.map(rowToFact);
  }

  /**
   * ATO-199. The active facts the prompt may carry: `list()` without
   * the name-like facts no check has vouched for (an invented name, or
   * one not checked yet). They stay on disk and in `list()` — listings
   * show them marked so the user can confirm or remove them — but the
   * agent never addresses the user by them, and nothing downstream of
   * the prompt (votes, reflection) treats them as known.
   */
  listForPrompt(): ProfileFact[] {
    return this.list().filter(isProfileFactPromptVisible);
  }

  /**
   * ATO-199. Active name-like facts the startup check has to look at:
   * never checked, or checked and found `ungrounded` (re-checked against
   * the sessions written since, in case the user has said it by now).
   */
  listNameFactsToCheck(): ProfileNameFactToCheck[] {
    const rows = this.selectAllActiveStmt.all() as ProfileRow[];
    const out: ProfileNameFactToCheck[] = [];
    for (const row of rows) {
      if (!isNameProfileKey(row.key)) continue;
      const fact = rowToFact(row);
      if (fact.nameGrounding === null) {
        out.push({ fact, checkedAt: null });
      } else if (fact.nameGrounding === "ungrounded") {
        out.push({ fact, checkedAt: row.name_checked_at });
      }
    }
    return out;
  }

  /**
   * ATO-199. Record a grounding verdict on one row. No-op (returns
   * `false`) for a row that is gone or whose key is not name-like.
   * `ifUnconfirmed` writes only over "not checked yet" or `ungrounded`:
   * the startup check, whose walk yields, must not undo a confirmation
   * `memory.profile.set` or reflection recorded while it ran.
   */
  markNameGrounding(
    id: number,
    status: NameGroundingStatus,
    now: number = Date.now(),
    options: { ifUnconfirmed?: boolean } = {},
  ): boolean {
    const row = this.selectActiveByIdStmt.get(id) as ProfileRow | undefined;
    if (!row || !isNameProfileKey(row.key)) return false;
    const stmt = options.ifUnconfirmed
      ? this.markUnconfirmedNameGroundingStmt
      : this.markNameGroundingStmt;
    const result = stmt.run({ id, status, now }) as { changes: number };
    return result.changes > 0;
  }

  /**
   * Memory-v2 phase 4. Walk the full bi-temporal chain for `key` in
   * temporal order (oldest first). Includes both superseded and
   * active rows. The active row (if any) is the last entry. Returns
   * `[]` when the key has no history.
   *
   * Cross-key supersession (e.g. `name` → `full_name`) is **not**
   * traversed here — `history` is per-key by design so the rendered
   * timeline matches the column header the user sees in
   * `### profile`. For cross-key walks, follow `supersededBy` /
   * `supersedes` pointers via `getById`.
   */
  history(key: string): ProfileFact[] {
    const normalisedKey = validateKey(key);
    const rows = this.historyByKeyStmt.all(normalisedKey) as ProfileRow[];
    return rows.map(rowToFact);
  }

  close(): void {
    this.db.close();
  }
}

export class ProfileValidationError extends Error {
  constructor(
    public readonly field: "key" | "value" | "keywords",
    message: string,
  ) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

function rowToFact(row: ProfileRow): ProfileFact {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    validFrom: row.valid_from,
    updatedAt: row.updated_at,
    pinned: row.pinned !== 0,
    keywords: parseKeywords(row.keywords),
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    voteScore: row.vote_score ?? 0,
    // Anything but a known verdict — a value some later build wrote, a
    // non-name key — reads as unchecked.
    nameGrounding:
      isNameProfileKey(row.key) && isNameGroundingStatus(row.name_grounding)
        ? row.name_grounding
        : null,
  };
}

function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((k): k is string => typeof k === "string");
    }
  } catch {
    // Legacy / corrupt payloads degrade to empty rather than throwing —
    // contextual gating is a soft feature and should never brick reads.
  }
  return [];
}

function validateKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ProfileValidationError("key", "profile key must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ProfileValidationError("key", "profile key must be non-empty");
  }
  if (trimmed.length > PROFILE_KEY_MAX_LENGTH) {
    throw new ProfileValidationError(
      "key",
      `profile key must be at most ${PROFILE_KEY_MAX_LENGTH} chars`,
    );
  }
  if (!KEY_PATTERN.test(trimmed)) {
    throw new ProfileValidationError(
      "key",
      "profile key must start with alphanumeric and contain only [a-zA-Z0-9_.-]",
    );
  }
  return trimmed;
}

function validateValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ProfileValidationError("value", "profile value must be a string");
  }
  if (raw.length === 0) {
    throw new ProfileValidationError(
      "value",
      "profile value must be non-empty",
    );
  }
  if (raw.length > PROFILE_VALUE_MAX_LENGTH) {
    throw new ProfileValidationError(
      "value",
      `profile value must be at most ${PROFILE_VALUE_MAX_LENGTH} chars`,
    );
  }
  return raw;
}

function validateKeywords(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ProfileValidationError(
      "keywords",
      "keywords must be a string array",
    );
  }
  if (raw.length > PROFILE_KEYWORDS_MAX) {
    throw new ProfileValidationError(
      "keywords",
      `keywords must contain at most ${PROFILE_KEYWORDS_MAX} entries`,
    );
  }
  const normalised: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      throw new ProfileValidationError(
        "keywords",
        `keywords[${i}] must be a string`,
      );
    }
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) {
      throw new ProfileValidationError(
        "keywords",
        `keywords[${i}] must be non-empty`,
      );
    }
    if (trimmed.length > PROFILE_KEYWORD_MAX_LENGTH) {
      throw new ProfileValidationError(
        "keywords",
        `keywords[${i}] must be at most ${PROFILE_KEYWORD_MAX_LENGTH} chars`,
      );
    }
    if (!normalised.includes(trimmed)) normalised.push(trimmed);
  }
  return normalised;
}
