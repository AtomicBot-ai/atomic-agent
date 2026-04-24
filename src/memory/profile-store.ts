import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { applyMigrations } from "./memory-schema.js";

export interface ProfileFact {
  key: string;
  value: string;
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
}

export interface ProfileStoreOptions {
  dbFile: string;
}

export interface ProfileSetOptions {
  pinned?: boolean;
  keywords?: string[];
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
  key: string;
  value: string;
  updated_at: number;
  pinned: number;
  keywords: string | null;
}

/**
 * Durable key/value store for user profile facts. All methods are
 * synchronous because the volume is tiny (typically under 50 entries)
 * and `better-sqlite3` is already synchronous.
 */
export class ProfileStore {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly selectAllStmt: Database.Statement;

  constructor(options: ProfileStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.upsertStmt = this.db.prepare(
      `INSERT INTO profile_facts (key, value, updated_at, pinned, keywords)
       VALUES (@key, @value, @updated_at, @pinned, @keywords)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         pinned = excluded.pinned,
         keywords = excluded.keywords`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM profile_facts WHERE key = ?`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT key, value, updated_at, pinned, keywords
         FROM profile_facts WHERE key = ?`,
    );
    this.selectAllStmt = this.db.prepare(
      `SELECT key, value, updated_at, pinned, keywords
         FROM profile_facts ORDER BY key ASC`,
    );
  }

  set(
    key: string,
    value: string,
    optionsOrNow?: ProfileSetOptions | number,
    nowArg?: number,
  ): ProfileFact {
    const normalisedKey = validateKey(key);
    const normalisedValue = validateValue(value);
    // Legacy call form `set(key, value, now)` kept for back-compat with
    // the earlier 3-arg signature used across tests and the reflection
    // runner before contextual-gating landed.
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
    this.upsertStmt.run({
      key: normalisedKey,
      value: normalisedValue,
      updated_at: now,
      pinned: pinned ? 1 : 0,
      keywords: keywords.length > 0 ? JSON.stringify(keywords) : null,
    });
    return {
      key: normalisedKey,
      value: normalisedValue,
      updatedAt: now,
      pinned,
      keywords,
    };
  }

  remove(key: string): boolean {
    const normalisedKey = validateKey(key);
    const result = this.deleteStmt.run(normalisedKey) as { changes: number };
    return result.changes > 0;
  }

  get(key: string): ProfileFact | null {
    const normalisedKey = validateKey(key);
    const row = this.selectStmt.get(normalisedKey) as ProfileRow | undefined;
    if (!row) return null;
    return rowToFact(row);
  }

  list(): ProfileFact[] {
    const rows = this.selectAllStmt.all() as ProfileRow[];
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
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
    pinned: row.pinned !== 0,
    keywords: parseKeywords(row.keywords),
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
