import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMetrics } from "../tracing/agent-metrics.js";

import { applyMigrations } from "./memory-schema.js";

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
}

export interface ProfileStoreOptions {
  dbFile: string;
  /**
   * Memory-v2 phase 4. Optional metrics sink for
   * `agent.memory.profile.superseded`. The store still functions
   * correctly without it; only observability degrades.
   */
  metrics?: AgentMetrics;
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
  private readonly insertStmt: Database.Statement;
  private readonly markSupersededStmt: Database.Statement;
  private readonly preflipParentStmt!: Database.Statement;
  private readonly selectActiveByKeyStmt: Database.Statement;
  private readonly selectActiveByIdStmt: Database.Statement;
  private readonly selectAllActiveStmt: Database.Statement;
  private readonly historyByKeyStmt: Database.Statement;
  private readonly deleteActiveStmt: Database.Statement;

  constructor(options: ProfileStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    applyMigrations(this.db);
    this.metrics = options.metrics;
    this.insertStmt = this.db.prepare(
      `INSERT INTO profile_facts
         (key, value, pinned, keywords, valid_from, superseded_by,
          supersedes, created_at, updated_at)
       VALUES
         (@key, @value, @pinned, @keywords, @valid_from, NULL,
          @supersedes, @created_at, @updated_at)`,
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
              superseded_by, supersedes, created_at, updated_at
         FROM profile_facts
        WHERE key = ? AND superseded_by IS NULL`,
    );
    this.selectActiveByIdStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at
         FROM profile_facts
        WHERE id = ?`,
    );
    this.selectAllActiveStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at
         FROM profile_facts
        WHERE superseded_by IS NULL
        ORDER BY key ASC`,
    );
    this.historyByKeyStmt = this.db.prepare(
      `SELECT id, key, value, pinned, keywords, valid_from,
              superseded_by, supersedes, created_at, updated_at
         FROM profile_facts
        WHERE key = ?
        ORDER BY valid_from ASC, id ASC`,
    );
    this.deleteActiveStmt = this.db.prepare(
      `DELETE FROM profile_facts
        WHERE key = ? AND superseded_by IS NULL`,
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
      typeof optionsOrNow === "number"
        ? optionsOrNow
        : (nowArg ?? Date.now());
    const pinned = options.pinned === undefined ? true : Boolean(options.pinned);
    const keywords = pinned ? [] : validateKeywords(options.keywords);
    const supersedesKeyRaw = options.supersedesKey;
    const supersedesKey =
      supersedesKeyRaw !== undefined ? validateKey(supersedesKeyRaw) : null;

    const txn = this.db.transaction((): { id: number; supersedes: number | null } => {
      // Same-key auto-chain: if there is an active row for the
      // incoming key, capture its id so we can flip it after insert.
      const sameKeyActive = this.selectActiveByKeyStmt.get(normalisedKey) as
        | ProfileRow
        | undefined;
      // Cross-key supersession: only fires when `supersedesKey` was
      // provided AND differs from the incoming key (same-key is
      // already handled above).
      const crossKeyActive =
        supersedesKey !== null && supersedesKey !== normalisedKey
          ? (this.selectActiveByKeyStmt.get(supersedesKey) as
              | ProfileRow
              | undefined)
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
      };
    });

    const { id, supersedes } = txn();

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
      | ProfileRow
      | undefined;
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
    throw new ProfileValidationError("value", "profile value must be non-empty");
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
