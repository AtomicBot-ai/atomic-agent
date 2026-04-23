import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { applyMigrations } from "./memory-schema.js";

export type MemorySource = "agent" | "user";

export interface MemoryEntry {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: MemorySource;
  sessionId: string | null;
  workingDir: string | null;
  tags: string[];
}

export interface MemoryStoreOptions {
  dbFile: string;
  /** Hard cap on `memories` rows. When exceeded, oldest by `updated_at` are evicted. */
  maxEntries: number;
}

export interface MemoryStoreInput {
  content: string;
  tags?: string[];
  sessionId?: string | null;
  workingDir?: string | null;
  source?: MemorySource;
}

export interface MemoryRecallOptions {
  k?: number;
  scope?: "project" | "all";
  workingDir?: string | null;
  tags?: string[];
}

export interface MemoryListOptions {
  scope?: "project" | "all";
  workingDir?: string | null;
  limit?: number;
}

/** Hard ceiling on a single stored content value to keep the FTS index sane. */
export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
/** Hard ceiling on a single tag string. */
export const MEMORY_TAG_MAX_LENGTH = 40;
/** Hard ceiling on the number of tags per entry. */
export const MEMORY_MAX_TAGS = 16;
/** Hard ceiling on a recall query string. */
export const MEMORY_QUERY_MAX_LENGTH = 500;
/** Default number of results for recall when `k` is not specified. */
export const MEMORY_RECALL_DEFAULT_K = 5;
/** Cap on `k` to protect the prompt budget. */
export const MEMORY_RECALL_MAX_K = 50;
/** Cap on `list.limit` to protect the prompt budget. */
export const MEMORY_LIST_MAX_LIMIT = 200;

interface MemoryRow {
  id: number;
  content: string;
  created_at: number;
  updated_at: number;
  source: string;
  session_id: string | null;
  working_dir: string | null;
  tags: string | null;
}

/**
 * Durable freeform memory with FTS5 keyword search. Unlike `ProfileStore`
 * (key/value facts auto-rendered into every prompt), `MemoryStore`
 * entries are only surfaced when the agent explicitly calls
 * `memory.notes.recall`. Entries are ranked by BM25; no prompt contact
 * happens implicitly, so adding a memory never invalidates the stable
 * prefix KV cache.
 *
 * All methods are synchronous because volume is bounded by `maxEntries`
 * (default ~1000) and `better-sqlite3` is already synchronous.
 */
export class MemoryStore {
  private readonly db: Database.Database;
  private readonly maxEntries: number;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly evictStmt: Database.Statement;

  constructor(options: MemoryStoreOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error(
        `MemoryStore: maxEntries must be a positive integer, got ${options.maxEntries}`,
      );
    }
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new Database(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.maxEntries = options.maxEntries;
    this.insertStmt = this.db.prepare(
      `INSERT INTO memories
         (content, created_at, updated_at, source, session_id, working_dir, tags)
       VALUES
         (@content, @created_at, @updated_at, @source, @session_id, @working_dir, @tags)`,
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.getStmt = this.db.prepare(
      `SELECT id, content, created_at, updated_at, source, session_id, working_dir, tags
         FROM memories WHERE id = ?`,
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS count FROM memories`);
    this.evictStmt = this.db.prepare(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories ORDER BY updated_at ASC, id ASC LIMIT ?
       )`,
    );
  }

  /**
   * Persist a new freeform memory. The store never upserts by content —
   * each call is a new row, so duplicates are the caller's responsibility.
   * After insert, evicts oldest rows by `updated_at` when over the cap.
   */
  store(input: MemoryStoreInput, now: number = Date.now()): MemoryEntry {
    const content = validateContent(input.content);
    const tags = validateTags(input.tags);
    const source = validateSource(input.source ?? "agent");
    const sessionId = validateOptionalString(input.sessionId, "sessionId");
    const workingDir = validateOptionalString(input.workingDir, "workingDir");
    const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
    const result = this.insertStmt.run({
      content,
      created_at: now,
      updated_at: now,
      source,
      session_id: sessionId,
      working_dir: workingDir,
      tags: tagsJson,
    }) as { lastInsertRowid: number | bigint };
    const id = Number(result.lastInsertRowid);
    this.evictOverflow();
    return {
      id,
      content,
      createdAt: now,
      updatedAt: now,
      source,
      sessionId,
      workingDir,
      tags,
    };
  }

  /**
   * BM25-ranked keyword search over `memories_fts`. Returns at most `k`
   * entries (default `MEMORY_RECALL_DEFAULT_K`, hard-capped by
   * `MEMORY_RECALL_MAX_K`). `scope: "project"` restricts to rows whose
   * `working_dir` matches `opts.workingDir`; the caller is responsible
   * for passing the current working directory when they want that
   * filter.
   *
   * When `tags` is given, every requested tag must be present in the
   * row's tag set (AND semantics). Empty / whitespace-only query
   * returns an empty array without a database round-trip.
   */
  recall(query: string, opts: MemoryRecallOptions = {}): MemoryEntry[] {
    const normalizedQuery = validateQuery(query);
    const ftsQuery = buildFtsQuery(normalizedQuery);
    if (ftsQuery.length === 0) return [];
    const k = clampPositiveInt(
      opts.k ?? MEMORY_RECALL_DEFAULT_K,
      1,
      MEMORY_RECALL_MAX_K,
      "k",
    );
    const scope = opts.scope ?? "all";
    const requiredTags = validateTags(opts.tags);
    const where: string[] = [`memories_fts MATCH ?`];
    const params: unknown[] = [ftsQuery];
    if (scope === "project") {
      const dir = validateOptionalString(opts.workingDir, "workingDir");
      if (dir === null) return [];
      where.push(`m.working_dir = ?`);
      params.push(dir);
    }
    const sql = `
      SELECT m.id, m.content, m.created_at, m.updated_at,
             m.source, m.session_id, m.working_dir, m.tags
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(memories_fts) ASC
       LIMIT ?`;
    params.push(k * (requiredTags.length > 0 ? 4 : 1));
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    const mapped = rows.map(rowToEntry);
    const filtered =
      requiredTags.length === 0
        ? mapped
        : mapped.filter((e) => requiredTags.every((t) => e.tags.includes(t)));
    return filtered.slice(0, k);
  }

  get(id: number): MemoryEntry | null {
    const normalizedId = validateId(id);
    const row = this.getStmt.get(normalizedId) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  remove(id: number): boolean {
    const normalizedId = validateId(id);
    const result = this.deleteStmt.run(normalizedId) as { changes: number };
    return result.changes > 0;
  }

  /**
   * Return entries ordered by `updated_at DESC`. `scope: "project"`
   * filters by `working_dir`. `limit` defaults to 50 and is hard-capped
   * by `MEMORY_LIST_MAX_LIMIT`.
   */
  list(opts: MemoryListOptions = {}): MemoryEntry[] {
    const limit = clampPositiveInt(
      opts.limit ?? 50,
      1,
      MEMORY_LIST_MAX_LIMIT,
      "limit",
    );
    const scope = opts.scope ?? "all";
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope === "project") {
      const dir = validateOptionalString(opts.workingDir, "workingDir");
      if (dir === null) return [];
      where.push(`working_dir = ?`);
      params.push(dir);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT id, content, created_at, updated_at,
             source, session_id, working_dir, tags
        FROM memories
        ${whereClause}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  /** Total number of stored entries. Useful for tests and diagnostics. */
  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private evictOverflow(): void {
    const current = this.count();
    if (current <= this.maxEntries) return;
    const excess = current - this.maxEntries;
    this.evictStmt.run(excess);
  }
}

export class MemoryValidationError extends Error {
  constructor(
    public readonly field: "content" | "tags" | "query" | "id" | "source" | "sessionId" | "workingDir" | "k" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

function validateContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError(
      "content",
      "memory content must be a string",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new MemoryValidationError(
      "content",
      "memory content must be non-empty",
    );
  }
  if (trimmed.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new MemoryValidationError(
      "content",
      `memory content must be at most ${MEMORY_CONTENT_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new MemoryValidationError("tags", "tags must be a string array");
  }
  if (raw.length > MEMORY_MAX_TAGS) {
    throw new MemoryValidationError(
      "tags",
      `tags must contain at most ${MEMORY_MAX_TAGS} entries`,
    );
  }
  const normalized: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be a string`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be non-empty`,
      );
    }
    if (trimmed.length > MEMORY_TAG_MAX_LENGTH) {
      throw new MemoryValidationError(
        "tags",
        `tags[${i}] must be at most ${MEMORY_TAG_MAX_LENGTH} chars`,
      );
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

function validateQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError("query", "query must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length > MEMORY_QUERY_MAX_LENGTH) {
    throw new MemoryValidationError(
      "query",
      `query must be at most ${MEMORY_QUERY_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateSource(raw: unknown): MemorySource {
  if (raw === "agent" || raw === "user") return raw;
  throw new MemoryValidationError(
    "source",
    `source must be 'agent' or 'user', got ${JSON.stringify(raw)}`,
  );
}

function validateOptionalString(
  raw: unknown,
  field: "sessionId" | "workingDir",
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new MemoryValidationError(field, `${field} must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateId(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    throw new MemoryValidationError(
      "id",
      `id must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function clampPositiveInt(
  raw: unknown,
  min: number,
  max: number,
  field: "k" | "limit",
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new MemoryValidationError(
      field,
      `${field} must be an integer, got ${JSON.stringify(raw)}`,
    );
  }
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source === "user" ? "user" : "agent",
    sessionId: row.session_id,
    workingDir: row.working_dir,
    tags: parseTags(row.tags),
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    // Malformed legacy tag payloads degrade to empty rather than throwing.
  }
  return [];
}

/**
 * FTS5 queries are their own tiny DSL: bare operators like `-`, `"`,
 * `(`, `*`, and column specifiers can make the grammar trip. Tokenize
 * on whitespace, drop anything non-alphanumeric-ish, wrap each surviving
 * token as a prefix match (`token*`), and join with OR so the caller
 * gets lenient keyword semantics. An empty output signals "no usable
 * terms — skip the query".
 */
function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
