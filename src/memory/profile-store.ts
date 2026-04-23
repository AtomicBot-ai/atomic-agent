import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { applyMigrations } from "./memory-schema.js";

export interface ProfileFact {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ProfileStoreOptions {
  dbFile: string;
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

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;

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
    this.db = new Database(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.upsertStmt = this.db.prepare(
      `INSERT INTO profile_facts (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM profile_facts WHERE key = ?`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT key, value, updated_at FROM profile_facts WHERE key = ?`,
    );
    this.selectAllStmt = this.db.prepare(
      `SELECT key, value, updated_at FROM profile_facts ORDER BY key ASC`,
    );
  }

  set(key: string, value: string, now: number = Date.now()): ProfileFact {
    const normalisedKey = validateKey(key);
    const normalisedValue = validateValue(value);
    this.upsertStmt.run({
      key: normalisedKey,
      value: normalisedValue,
      updated_at: now,
    });
    return { key: normalisedKey, value: normalisedValue, updatedAt: now };
  }

  remove(key: string): boolean {
    const normalisedKey = validateKey(key);
    const result = this.deleteStmt.run(normalisedKey) as { changes: number };
    return result.changes > 0;
  }

  get(key: string): ProfileFact | null {
    const normalisedKey = validateKey(key);
    const row = this.selectStmt.get(normalisedKey) as
      | { key: string; value: string; updated_at: number }
      | undefined;
    if (!row) return null;
    return { key: row.key, value: row.value, updatedAt: row.updated_at };
  }

  list(): ProfileFact[] {
    const rows = this.selectAllStmt.all() as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export class ProfileValidationError extends Error {
  constructor(
    public readonly field: "key" | "value",
    message: string,
  ) {
    super(message);
    this.name = "ProfileValidationError";
  }
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
