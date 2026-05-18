import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMetrics } from "../../tracing/agent-metrics.js";

import { applyMigrations } from "../memory-schema.js";

/**
 * Memory-v2 phase 5. A lesson is a distilled summary produced by the
 * cold-path consolidator from N related episodes (NOTEs). The
 * consolidator owns writes; the agent-facing surface is read-only
 * (recall by id or BM25 query, listIndex for the prompt's
 * `### lessons` pointer view).
 *
 * Lessons are **never overwritten** in-place — phase 7a's EDIT branch
 * (deferred) instead produces a new lesson that supersedes the old
 * one. Today only status / counters / `deprecated_at` mutate
 * post-creation (phase 6 lifecycle), and `tags` may be appended on
 * deprecation sweeps. `activation` and `principle` are immutable
 * once written, mirroring the append-only contract on
 * `MemoryEntry.content`.
 */
export interface Lesson {
  id: number;
  /** One-sentence "when this lesson applies" hook. */
  activation: string;
  /** 1–3 sentence durable observation. */
  principle: string;
  tags: string[];
  /**
   * `active` lessons appear in `### lessons` and BM25 recall.
   * `deprecated` lessons fall out of both but stay readable by id
   * (cross-phase invariant 9: archived items never deleted). Phase 6
   * owns the deprecation lifecycle; phase 5 only ships the column.
   */
  status: "active" | "deprecated";
  /** Phase 6 lifecycle counter — bumped when the agent uses a surfaced lesson. */
  successCount: number;
  /** Phase 6 lifecycle counter — bumped when a surfaced lesson misled the agent. */
  failureCount: number;
  /** IDs of the episodes (`memories.id`) consolidated into this lesson. */
  parentIds: number[];
  workingDir: string | null;
  createdAt: number;
  updatedAt: number;
  deprecatedAt: number | null;
}

export interface LessonStoreOptions {
  dbFile: string;
  /**
   * Maximum number of `active` lessons retained at once. When exceeded,
   * the oldest `(updated_at ASC, id ASC)` lessons are demoted to
   * `deprecated` rather than deleted — body still recoverable by id.
   * Used by phase 6's deprecation sweep; phase 5 just plumbs the cap.
   */
  maxEntries?: number;
  metrics?: AgentMetrics;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface CreateLessonInput {
  activation: string;
  principle: string;
  tags?: readonly string[];
  parentIds: readonly number[];
  workingDir?: string | null;
}

export interface LessonRecallOptions {
  query?: string;
  /** Direct id lookup; bypasses BM25 and the `active` filter. */
  id?: number;
  k?: number;
  /**
   * When `false` (default) BM25 recall only returns `active` lessons.
   * Set to `true` for diagnostics / id-history listings.
   */
  includeDeprecated?: boolean;
}

export interface LessonIndexEntry {
  id: number;
  activation: string;
  tags: string[];
  workingDir: string | null;
  updatedAt: number;
}

/** Maximum `activation` length. Roughly one sentence. */
export const LESSON_ACTIVATION_MAX_LENGTH = 240;
/** Maximum `principle` length. ~3 sentences. */
export const LESSON_PRINCIPLE_MAX_LENGTH = 800;
/** Hard ceiling on tag count per lesson. Mirrors `MemoryStore`. */
export const LESSON_MAX_TAGS = 12;
/** Max length per tag. */
export const LESSON_TAG_MAX_LENGTH = 40;
/** Default recall K. */
export const LESSON_RECALL_DEFAULT_K = 2;
/** Cap on K. */
export const LESSON_RECALL_MAX_K = 10;
/** Default listIndex limit. */
export const LESSON_INDEX_DEFAULT_LIMIT = 20;
export const LESSON_INDEX_MAX_LIMIT = 100;

const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,39}$/;

interface LessonRow {
  id: number;
  activation: string;
  principle: string;
  tags: string | null;
  status: string;
  success_count: number;
  failure_count: number;
  parent_ids: string;
  working_dir: string | null;
  created_at: number;
  updated_at: number;
  deprecated_at: number | null;
}

export class LessonValidationError extends Error {
  constructor(
    public readonly field:
      | "activation"
      | "principle"
      | "tags"
      | "parentIds"
      | "id"
      | "query",
    message: string,
  ) {
    super(message);
    this.name = "LessonValidationError";
  }
}

/**
 * Synchronous SQLite-backed store for distilled lessons. Lives in
 * the same `memory.sqlite` file as `MemoryStore` / `LinkStore` /
 * `ProfileStore` so transactions can span tables (e.g. archive
 * parents + create lesson in one txn).
 */
export class LessonStore {
  private readonly db: Database.Database;
  private readonly metrics: AgentMetrics | undefined;
  private readonly maxEntries: number | undefined;
  private readonly clock: () => number;

  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listActiveStmt: Database.Statement;
  private readonly recallActiveStmt: Database.Statement;
  private readonly recallAnyStmt: Database.Statement;
  private readonly markDeprecatedStmt: Database.Statement;
  private readonly bumpSuccessStmt: Database.Statement;
  private readonly bumpFailureStmt: Database.Statement;
  private readonly countActiveStmt: Database.Statement;
  private readonly countAllStmt: Database.Statement;

  constructor(options: LessonStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.metrics = options.metrics;
    this.maxEntries = options.maxEntries;
    this.clock = options.now ?? Date.now;

    this.insertStmt = this.db.prepare(
      `INSERT INTO lessons (
         activation, principle, tags, status,
         success_count, failure_count, parent_ids,
         working_dir, created_at, updated_at, deprecated_at)
       VALUES (@activation, @principle, @tags, 'active',
               0, 0, @parent_ids,
               @working_dir, @now, @now, NULL)`,
    );
    this.getByIdStmt = this.db.prepare(
      `SELECT id, activation, principle, tags, status,
              success_count, failure_count, parent_ids,
              working_dir, created_at, updated_at, deprecated_at
         FROM lessons
        WHERE id = ?`,
    );
    this.listActiveStmt = this.db.prepare(
      `SELECT id, activation, tags, working_dir, updated_at
         FROM lessons
        WHERE status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`,
    );
    this.recallActiveStmt = this.db.prepare(
      `SELECT l.id, l.activation, l.principle, l.tags, l.status,
              l.success_count, l.failure_count, l.parent_ids,
              l.working_dir, l.created_at, l.updated_at, l.deprecated_at,
              bm25(lessons_fts) AS score
         FROM lessons_fts
         JOIN lessons l ON l.id = lessons_fts.rowid
        WHERE lessons_fts MATCH ?
          AND l.status = 'active'
        ORDER BY score ASC
        LIMIT ?`,
    );
    this.recallAnyStmt = this.db.prepare(
      `SELECT l.id, l.activation, l.principle, l.tags, l.status,
              l.success_count, l.failure_count, l.parent_ids,
              l.working_dir, l.created_at, l.updated_at, l.deprecated_at,
              bm25(lessons_fts) AS score
         FROM lessons_fts
         JOIN lessons l ON l.id = lessons_fts.rowid
        WHERE lessons_fts MATCH ?
        ORDER BY score ASC
        LIMIT ?`,
    );
    this.markDeprecatedStmt = this.db.prepare(
      `UPDATE lessons
          SET status = 'deprecated',
              deprecated_at = @now,
              updated_at = @now
        WHERE id = @id AND status = 'active'`,
    );
    this.bumpSuccessStmt = this.db.prepare(
      `UPDATE lessons
          SET success_count = success_count + 1,
              updated_at = @now
        WHERE id = @id`,
    );
    this.bumpFailureStmt = this.db.prepare(
      `UPDATE lessons
          SET failure_count = failure_count + 1,
              updated_at = @now
        WHERE id = @id`,
    );
    this.countActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM lessons WHERE status = 'active'`,
    );
    this.countAllStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM lessons`);
  }

  /**
   * Insert a new lesson. Validation throws `LessonValidationError`
   * (caller — typically the consolidator — folds these into metrics
   * and never lets them bubble out of the tick).
   */
  create(input: CreateLessonInput): Lesson {
    const activation = validateActivation(input.activation);
    const principle = validatePrinciple(input.principle);
    const tags = validateTags(input.tags);
    const parentIds = validateParentIds(input.parentIds);
    const workingDir =
      input.workingDir === null ||
      input.workingDir === undefined ||
      input.workingDir === ""
        ? null
        : String(input.workingDir);
    const now = this.clock();
    const result = this.insertStmt.run({
      activation,
      principle,
      tags: tags.length > 0 ? JSON.stringify(tags) : null,
      parent_ids: JSON.stringify(parentIds),
      working_dir: workingDir,
      now,
    }) as { lastInsertRowid: number | bigint };
    const id = Number(result.lastInsertRowid);
    this.metrics?.recordLessonCreated({
      lessonId: id,
      parentCount: parentIds.length,
    });
    return {
      id,
      activation,
      principle,
      tags,
      status: "active",
      successCount: 0,
      failureCount: 0,
      parentIds: [...parentIds],
      workingDir,
      createdAt: now,
      updatedAt: now,
      deprecatedAt: null,
    };
  }

  /**
   * Direct id lookup. Returns `null` for missing ids. Reads
   * **regardless of `status`** so postmortems / audits can still
   * walk back from a parent's `consolidated_into` pointer even
   * after the lesson is deprecated.
   */
  getById(id: number): Lesson | null {
    const normalised = validateLessonId(id);
    const row = this.getByIdStmt.get(normalised) as LessonRow | undefined;
    if (!row) return null;
    return rowToLesson(row);
  }

  /**
   * BM25 recall over `lessons_fts` (activation + principle + tags).
   * Defaults to `active` lessons only; pass `includeDeprecated=true`
   * to widen the search. Empty / blank query returns `[]` — callers
   * should use `listIndex` for the recent-items view.
   */
  recall(opts: LessonRecallOptions = {}): Lesson[] {
    if (opts.id !== undefined) {
      const lesson = this.getById(opts.id);
      return lesson ? [lesson] : [];
    }
    const rawQuery = (opts.query ?? "").trim();
    if (rawQuery.length === 0) return [];
    if (rawQuery.length > 500) {
      throw new LessonValidationError(
        "query",
        "lesson recall query must be at most 500 chars",
      );
    }
    const k = clampPositiveInt(
      opts.k ?? LESSON_RECALL_DEFAULT_K,
      1,
      LESSON_RECALL_MAX_K,
    );
    const ftsQuery = buildFtsQuery(rawQuery);
    if (ftsQuery === null) return [];
    const stmt = opts.includeDeprecated
      ? this.recallAnyStmt
      : this.recallActiveStmt;
    const rows = stmt.all(ftsQuery, k) as LessonRow[];
    return rows.map(rowToLesson);
  }

  /**
   * Compact pointer view over recent `active` lessons. Returns the
   * `activation` (not `principle`) plus tags + working_dir so the
   * `### lessons` renderer can produce one-line pointer rows
   * without leaking the full body. Full body is gated behind
   * `memory.lessons.recall { id }`.
   */
  listIndex(opts: { limit?: number } = {}): LessonIndexEntry[] {
    const limit = clampPositiveInt(
      opts.limit ?? LESSON_INDEX_DEFAULT_LIMIT,
      1,
      LESSON_INDEX_MAX_LIMIT,
    );
    const rows = this.listActiveStmt.all(limit) as Array<{
      id: number;
      activation: string;
      tags: string | null;
      working_dir: string | null;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      activation: r.activation,
      tags: parseTags(r.tags),
      workingDir: r.working_dir,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Demote an `active` lesson to `deprecated`. Idempotent — calling
   * twice on the same id does nothing on the second call. Returns
   * `true` when the row actually flipped. Phase 6 owns lifecycle
   * decisions; phase 5 exposes the primitive.
   */
  markDeprecated(id: number, reason?: string): boolean {
    const normalised = validateLessonId(id);
    const now = this.clock();
    const r = this.markDeprecatedStmt.run({
      id: normalised,
      now,
    }) as { changes: number };
    if (r.changes > 0) {
      this.metrics?.recordLessonDeprecated({
        lessonId: normalised,
        reason: reason ?? "unspecified",
      });
      return true;
    }
    return false;
  }

  /** Phase 6 hook. Idempotent counter bump. */
  bumpSuccess(id: number): boolean {
    const normalised = validateLessonId(id);
    const now = this.clock();
    const r = this.bumpSuccessStmt.run({ id: normalised, now }) as {
      changes: number;
    };
    return r.changes > 0;
  }

  /** Phase 6 hook. Idempotent counter bump. */
  bumpFailure(id: number): boolean {
    const normalised = validateLessonId(id);
    const now = this.clock();
    const r = this.bumpFailureStmt.run({ id: normalised, now }) as {
      changes: number;
    };
    return r.changes > 0;
  }

  /** Total active lessons. */
  countActive(): number {
    return (this.countActiveStmt.get() as { c: number }).c;
  }

  /** Total lessons regardless of status. */
  countAll(): number {
    return (this.countAllStmt.get() as { c: number }).c;
  }

  /**
   * Hard-cap helper. Returns the ids of lessons that should be
   * demoted to honour `maxEntries`. Caller decides whether to
   * flip them via `markDeprecated`. Returns `[]` when below the
   * cap. Phase 6 wires this on every consolidator tick; phase 5
   * leaves it dormant.
   */
  pickOverflowForDeprecation(): number[] {
    if (this.maxEntries === undefined) return [];
    const active = this.countActive();
    if (active <= this.maxEntries) return [];
    const overflow = active - this.maxEntries;
    const rows = this.db
      .prepare(
        `SELECT id FROM lessons
           WHERE status = 'active'
           ORDER BY updated_at ASC, id ASC
           LIMIT ?`,
      )
      .all(overflow) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}

function rowToLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    activation: row.activation,
    principle: row.principle,
    tags: parseTags(row.tags),
    status: row.status === "deprecated" ? "deprecated" : "active",
    successCount: row.success_count,
    failureCount: row.failure_count,
    parentIds: parseParentIds(row.parent_ids),
    workingDir: row.working_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deprecatedAt: row.deprecated_at,
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
    /* corrupt payload */
  }
  return [];
}

function parseParentIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    /* corrupt payload */
  }
  return [];
}

function validateActivation(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new LessonValidationError(
      "activation",
      "activation must be a string",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new LessonValidationError(
      "activation",
      "activation must be non-empty",
    );
  }
  if (trimmed.length > LESSON_ACTIVATION_MAX_LENGTH) {
    throw new LessonValidationError(
      "activation",
      `activation must be at most ${LESSON_ACTIVATION_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validatePrinciple(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new LessonValidationError("principle", "principle must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new LessonValidationError(
      "principle",
      "principle must be non-empty",
    );
  }
  if (trimmed.length > LESSON_PRINCIPLE_MAX_LENGTH) {
    throw new LessonValidationError(
      "principle",
      `principle must be at most ${LESSON_PRINCIPLE_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateTags(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (trimmed.length > LESSON_TAG_MAX_LENGTH) continue;
    if (!TAG_PATTERN.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= LESSON_MAX_TAGS) break;
  }
  return out;
}

function validateParentIds(raw: readonly number[]): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new LessonValidationError(
      "parentIds",
      "parentIds must contain at least one episode id",
    );
  }
  const out: number[] = [];
  for (const id of raw) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new LessonValidationError(
        "parentIds",
        "every parentIds entry must be a positive integer",
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function validateLessonId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new LessonValidationError("id", "lesson id must be a positive integer");
  }
  return raw;
}

function clampPositiveInt(raw: number, lo: number, hi: number): number {
  if (!Number.isFinite(raw)) return lo;
  const n = Math.floor(raw);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Coerce a free-form recall query into an FTS5 MATCH expression. We
 * follow the same approach as `MemoryStore.recall`: split on
 * non-alphanumerics, drop empty tokens, escape any remaining quotes,
 * and OR them together. Returns `null` when the query contains no
 * useful tokens (FTS5 rejects empty MATCH expressions).
 */
function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
