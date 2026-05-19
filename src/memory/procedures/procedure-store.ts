import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import { applyMigrations } from "../memory-schema.js";

/**
 * Memory-v2 phase 7b (Path F, MemP-style). A procedure is a
 * read-only "how-to" template — an ordered list of advisory steps
 * the agent **reads** before tackling a similar task. It is **never**
 * auto-executed by the runtime (cross-phase invariant 20): the agent
 * either follows the procedure on its next inference, consciously
 * deviates, or ignores it entirely. Pinned by
 * `procedure-store.test.ts` scenario 7b.D ("procedure is read-only").
 *
 * Procedures are produced **alongside** a parent lesson by the same
 * single distillation LLM call per cluster (invariant 21). They live
 * in their own SQLite table because their lifecycle is independent
 * (recall by `### procedures`, cascade deprecation when the parent
 * lesson is deprecated, vote-aware ranking shared with the rest of
 * the corpus). Activation / steps / tags are immutable once written;
 * only metadata (status, counters, vote_score, updated_at) mutates.
 */
export interface ProcedureStep {
  /** Short imperative description, 1 sentence. */
  description: string;
  /**
   * Optional tool name hint (e.g. `"os.fs.glob"`). Stored so the
   * recall-hit detector can compare the agent's actual tool-call
   * chain against the procedure's expected shape (scenario 7b.C.5).
   * Empty / unknown ⇒ `null`.
   */
  toolHint: string | null;
}

export interface Procedure {
  id: number;
  activation: string;
  steps: ProcedureStep[];
  tags: string[];
  status: "active" | "deprecated";
  successCount: number;
  failureCount: number;
  useCount: number;
  voteScore: number;
  parentLessonIds: number[];
  parentMemoryIds: number[];
  source: "consolidator" | "manual";
  workingDir: string | null;
  createdAt: number;
  updatedAt: number;
  deprecatedAt: number | null;
}

export interface ProcedureStoreOptions {
  dbFile: string;
  /**
   * Hard cap on active procedures. When exceeded, the oldest
   * `(vote_score ASC, updated_at ASC, id ASC)` are demoted — see
   * `pickOverflowForDeprecation` and scenario 7b.F.2.
   */
  maxEntries?: number;
  metrics?: AgentMetrics;
  now?: () => number;
}

export interface CreateProcedureInput {
  activation: string;
  steps: readonly ProcedureStep[];
  tags?: readonly string[];
  parentLessonIds: readonly number[];
  parentMemoryIds: readonly number[];
  source?: "consolidator" | "manual";
  workingDir?: string | null;
}

export interface ProcedureRecallOptions {
  query?: string;
  /** Direct id lookup; bypasses BM25 and the `active` filter. */
  id?: number;
  k?: number;
  includeDeprecated?: boolean;
  /**
   * Memory-v2 phase 7b mirrors the lesson recall path. When set,
   * fetches a wider BM25 pool then re-sorts by combined score:
   *
   *   combined = scoreBlend * voteScore
   *            + (1 - scoreBlend) * (successCount - failureCount)
   *
   * Sourced from `memory.voting.scoreBlend` at the call site.
   */
  scoreBlend?: number;
  rerankPoolMultiplier?: number;
}

export interface ProcedureIndexEntry {
  id: number;
  activation: string;
  tags: string[];
  workingDir: string | null;
  updatedAt: number;
}

export const PROCEDURE_ACTIVATION_MAX_LENGTH = 240;
export const PROCEDURE_DESCRIPTION_MAX_LENGTH = 240;
export const PROCEDURE_TOOL_HINT_MAX_LENGTH = 64;
export const PROCEDURE_MIN_STEPS = 2;
export const PROCEDURE_MAX_STEPS = 8;
export const PROCEDURE_MAX_TAGS = 12;
export const PROCEDURE_TAG_MAX_LENGTH = 40;
export const PROCEDURE_RECALL_DEFAULT_K = 2;
export const PROCEDURE_RECALL_MAX_K = 10;
export const PROCEDURE_INDEX_DEFAULT_LIMIT = 20;
export const PROCEDURE_INDEX_MAX_LIMIT = 100;

const TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]{0,63}$/;
const TOOL_HINT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]{0,63}$/;

interface ProcedureRow {
  id: number;
  activation: string;
  steps: string;
  tags: string | null;
  status: string;
  success_count: number;
  failure_count: number;
  use_count: number;
  vote_score: number;
  parent_lesson_ids: string;
  parent_memory_ids: string;
  source: string;
  working_dir: string | null;
  created_at: number;
  updated_at: number;
  deprecated_at: number | null;
}

export class ProcedureValidationError extends Error {
  constructor(
    public readonly field:
      | "activation"
      | "steps"
      | "tags"
      | "parentLessonIds"
      | "parentMemoryIds"
      | "id"
      | "query",
    message: string,
  ) {
    super(message);
    this.name = "ProcedureValidationError";
  }
}

/**
 * Synchronous SQLite-backed store for advisory procedures. Lives in
 * the same `memory.sqlite` file as `LessonStore` so the consolidator
 * can write a lesson + procedure in one transaction (invariant 21).
 */
export class ProcedureStore {
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
  private readonly bumpUseStmt: Database.Statement;
  private readonly bumpSuccessStmt: Database.Statement;
  private readonly bumpFailureStmt: Database.Statement;
  private readonly countActiveStmt: Database.Statement;
  private readonly countAllStmt: Database.Statement;

  constructor(options: ProcedureStoreOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
    this.metrics = options.metrics;
    this.maxEntries = options.maxEntries;
    this.clock = options.now ?? Date.now;

    this.insertStmt = this.db.prepare(
      `INSERT INTO procedures (
         activation, steps, tags, status,
         success_count, failure_count, use_count, vote_score,
         parent_lesson_ids, parent_memory_ids, source,
         working_dir, created_at, updated_at, deprecated_at)
       VALUES (@activation, @steps, @tags, 'active',
               0, 0, 0, 0.0,
               @parent_lesson_ids, @parent_memory_ids, @source,
               @working_dir, @now, @now, NULL)`,
    );
    this.getByIdStmt = this.db.prepare(
      `SELECT id, activation, steps, tags, status,
              success_count, failure_count, use_count, vote_score,
              parent_lesson_ids, parent_memory_ids, source,
              working_dir, created_at, updated_at, deprecated_at
         FROM procedures
        WHERE id = ?`,
    );
    this.listActiveStmt = this.db.prepare(
      `SELECT id, activation, tags, working_dir, updated_at, vote_score
         FROM procedures
        WHERE status = 'active'
        ORDER BY vote_score DESC, updated_at DESC, id DESC
        LIMIT ?`,
    );
    this.recallActiveStmt = this.db.prepare(
      `SELECT p.id, p.activation, p.steps, p.tags, p.status,
              p.success_count, p.failure_count, p.use_count, p.vote_score,
              p.parent_lesson_ids, p.parent_memory_ids, p.source,
              p.working_dir, p.created_at, p.updated_at, p.deprecated_at,
              bm25(procedures_fts) AS score
         FROM procedures_fts
         JOIN procedures p ON p.id = procedures_fts.rowid
        WHERE procedures_fts MATCH ?
          AND p.status = 'active'
        ORDER BY score ASC
        LIMIT ?`,
    );
    this.recallAnyStmt = this.db.prepare(
      `SELECT p.id, p.activation, p.steps, p.tags, p.status,
              p.success_count, p.failure_count, p.use_count, p.vote_score,
              p.parent_lesson_ids, p.parent_memory_ids, p.source,
              p.working_dir, p.created_at, p.updated_at, p.deprecated_at,
              bm25(procedures_fts) AS score
         FROM procedures_fts
         JOIN procedures p ON p.id = procedures_fts.rowid
        WHERE procedures_fts MATCH ?
        ORDER BY score ASC
        LIMIT ?`,
    );
    this.markDeprecatedStmt = this.db.prepare(
      `UPDATE procedures
          SET status = 'deprecated',
              deprecated_at = @now,
              updated_at = @now
        WHERE id = @id AND status = 'active'`,
    );
    this.bumpUseStmt = this.db.prepare(
      `UPDATE procedures
          SET use_count = use_count + 1,
              updated_at = @now
        WHERE id = @id`,
    );
    this.bumpSuccessStmt = this.db.prepare(
      `UPDATE procedures
          SET success_count = success_count + 1,
              updated_at = @now
        WHERE id = @id`,
    );
    this.bumpFailureStmt = this.db.prepare(
      `UPDATE procedures
          SET failure_count = failure_count + 1,
              updated_at = @now
        WHERE id = @id`,
    );
    this.countActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM procedures WHERE status = 'active'`,
    );
    this.countAllStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM procedures`);
  }

  create(input: CreateProcedureInput): Procedure {
    const activation = validateActivation(input.activation);
    const steps = validateSteps(input.steps);
    const tags = validateTags(input.tags);
    const parentLessonIds = validateParentIds(
      input.parentLessonIds,
      "parentLessonIds",
    );
    const parentMemoryIds = validateParentIds(
      input.parentMemoryIds,
      "parentMemoryIds",
    );
    const source: "consolidator" | "manual" = input.source ?? "consolidator";
    const workingDir =
      input.workingDir === null ||
      input.workingDir === undefined ||
      input.workingDir === ""
        ? null
        : String(input.workingDir);
    const now = this.clock();
    const result = this.insertStmt.run({
      activation,
      steps: JSON.stringify(steps),
      tags: tags.length > 0 ? JSON.stringify(tags) : null,
      parent_lesson_ids: JSON.stringify(parentLessonIds),
      parent_memory_ids: JSON.stringify(parentMemoryIds),
      source,
      working_dir: workingDir,
      now,
    }) as { lastInsertRowid: number | bigint };
    const id = Number(result.lastInsertRowid);
    this.metrics?.recordProcedureCreated({
      procedureId: id,
      source,
      parentLessonCount: parentLessonIds.length,
      parentMemoryCount: parentMemoryIds.length,
    });
    return {
      id,
      activation,
      steps,
      tags,
      status: "active",
      successCount: 0,
      failureCount: 0,
      useCount: 0,
      voteScore: 0,
      parentLessonIds: [...parentLessonIds],
      parentMemoryIds: [...parentMemoryIds],
      source,
      workingDir,
      createdAt: now,
      updatedAt: now,
      deprecatedAt: null,
    };
  }

  getById(id: number): Procedure | null {
    const normalised = validateProcedureId(id);
    const row = this.getByIdStmt.get(normalised) as ProcedureRow | undefined;
    if (!row) return null;
    return rowToProcedure(row);
  }

  recall(opts: ProcedureRecallOptions = {}): Procedure[] {
    if (opts.id !== undefined) {
      const proc = this.getById(opts.id);
      return proc ? [proc] : [];
    }
    const rawQuery = (opts.query ?? "").trim();
    if (rawQuery.length === 0) return [];
    if (rawQuery.length > 500) {
      throw new ProcedureValidationError(
        "query",
        "procedure recall query must be at most 500 chars",
      );
    }
    const k = clampPositiveInt(
      opts.k ?? PROCEDURE_RECALL_DEFAULT_K,
      1,
      PROCEDURE_RECALL_MAX_K,
    );
    const ftsQuery = buildFtsQuery(rawQuery);
    if (ftsQuery === null) return [];
    const stmt = opts.includeDeprecated
      ? this.recallAnyStmt
      : this.recallActiveStmt;

    if (typeof opts.scoreBlend === "number") {
      const blend = Math.max(0, Math.min(1, opts.scoreBlend));
      const poolMultiplier = Math.max(
        1,
        Math.min(5, Math.floor(opts.rerankPoolMultiplier ?? 3)),
      );
      const pool = Math.max(k, k * poolMultiplier);
      const rows = stmt.all(ftsQuery, pool) as ProcedureRow[];
      const procs = rows.map(rowToProcedure);
      const indexed = procs.map((proc, idx) => ({
        proc,
        bm25Rank: idx,
        combined: computeProcedureCombinedScore(proc, blend),
      }));
      indexed.sort((a, b) => {
        if (a.combined !== b.combined) return b.combined - a.combined;
        return a.bm25Rank - b.bm25Rank;
      });
      return indexed.slice(0, k).map((entry) => entry.proc);
    }

    const rows = stmt.all(ftsQuery, k) as ProcedureRow[];
    return rows.map(rowToProcedure);
  }

  /**
   * Pointer view for the `### procedures` prompt section. Rows are
   * ordered by `vote_score DESC` then `updated_at DESC` so the
   * highest-confidence templates survive the renderer's token-budget
   * clip (scenario 7b.E.3). Full `steps[]` is **not** included —
   * drill-down requires `memory.procedures.recall { id }`.
   */
  listIndex(opts: { limit?: number } = {}): ProcedureIndexEntry[] {
    const limit = clampPositiveInt(
      opts.limit ?? PROCEDURE_INDEX_DEFAULT_LIMIT,
      1,
      PROCEDURE_INDEX_MAX_LIMIT,
    );
    const rows = this.listActiveStmt.all(limit) as Array<{
      id: number;
      activation: string;
      tags: string | null;
      working_dir: string | null;
      updated_at: number;
      vote_score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      activation: r.activation,
      tags: parseTags(r.tags),
      workingDir: r.working_dir,
      updatedAt: r.updated_at,
    }));
  }

  markDeprecated(id: number, reason?: string): boolean {
    const normalised = validateProcedureId(id);
    const now = this.clock();
    const r = this.markDeprecatedStmt.run({
      id: normalised,
      now,
    }) as { changes: number };
    if (r.changes > 0) {
      this.metrics?.recordProcedureDeprecated({
        procedureId: normalised,
        reason: reason ?? "unspecified",
      });
      return true;
    }
    return false;
  }

  bumpUse(id: number): boolean {
    const normalised = validateProcedureId(id);
    const now = this.clock();
    const r = this.bumpUseStmt.run({ id: normalised, now }) as {
      changes: number;
    };
    return r.changes > 0;
  }

  bumpSuccess(id: number): boolean {
    const normalised = validateProcedureId(id);
    const now = this.clock();
    const r = this.bumpSuccessStmt.run({ id: normalised, now }) as {
      changes: number;
    };
    return r.changes > 0;
  }

  bumpFailure(id: number): boolean {
    const normalised = validateProcedureId(id);
    const now = this.clock();
    const r = this.bumpFailureStmt.run({ id: normalised, now }) as {
      changes: number;
    };
    return r.changes > 0;
  }

  countActive(): number {
    return (this.countActiveStmt.get() as { c: number }).c;
  }

  countAll(): number {
    return (this.countAllStmt.get() as { c: number }).c;
  }

  /**
   * Cascade deprecation hook (architectural decision 5 = A). Called
   * by the consolidator when a parent lesson is deprecated: every
   * active procedure that lists the lesson id in `parent_lesson_ids`
   * is demoted in lock-step. Returns the procedure ids that
   * actually flipped this call.
   */
  deprecateByParentLesson(lessonId: number, reason: string): number[] {
    const normalised = validateProcedureId(lessonId);
    const rows = this.db
      .prepare(
        `SELECT id, parent_lesson_ids FROM procedures
           WHERE status = 'active'
             AND parent_lesson_ids LIKE ?`,
      )
      .all(`%${normalised}%`) as Array<{
      id: number;
      parent_lesson_ids: string;
    }>;
    const targets: number[] = [];
    for (const row of rows) {
      const parents = parseIdList(row.parent_lesson_ids);
      if (parents.includes(normalised)) targets.push(row.id);
    }
    const flipped: number[] = [];
    for (const id of targets) {
      if (this.markDeprecated(id, reason)) flipped.push(id);
    }
    return flipped;
  }

  /**
   * Phase 7b — age + dormancy predicate, mirrors lesson 7a.
   *
   * Returns ids of **active** procedures whose `success_count == 0`
   * AND `use_count == 0` AND `created_at <= now - deprecationAgeMs`.
   * A procedure that has been surfaced at least once (`use_count >=
   * 1`) survives indefinitely; only the FIFO sweep can retire it.
   */
  pickAgeDeprecationCandidates(args: {
    now: number;
    deprecationAgeMs: number;
    limit?: number;
  }): number[] {
    const threshold = args.now - Math.max(0, args.deprecationAgeMs);
    const limit = Math.max(0, args.limit ?? 1000);
    if (limit === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM procedures
           WHERE status = 'active'
             AND success_count = 0
             AND use_count = 0
             AND created_at <= ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
      )
      .all(threshold, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Phase 7b — vote-driven deprecation (scenario 7b.F.1). Mirrors
   * `LessonStore.pickVoteDeprecationCandidates` and pairs with the
   * vote-score-aware ranking in `recall()`.
   */
  pickVoteDeprecationCandidates(args: { limit?: number } = {}): number[] {
    const limit = Math.max(0, args.limit ?? 1000);
    if (limit === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM procedures
           WHERE status = 'active'
             AND success_count = 0
             AND vote_score < 0
           ORDER BY vote_score ASC, created_at ASC, id ASC
           LIMIT ?`,
      )
      .all(limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Phase 7b — hard-cap FIFO (scenario 7b.F.2). Ordering:
   * `(vote_score ASC, updated_at ASC, id ASC)` so downvoted rows
   * leave first, then the stalest by activity. Mirrors
   * `MemoryStore` utility eviction.
   */
  pickOverflowForDeprecation(): number[] {
    if (this.maxEntries === undefined) return [];
    const active = this.countActive();
    if (active <= this.maxEntries) return [];
    const overflow = active - this.maxEntries;
    const rows = this.db
      .prepare(
        `SELECT id FROM procedures
           WHERE status = 'active'
           ORDER BY vote_score ASC, updated_at ASC, id ASC
           LIMIT ?`,
      )
      .all(overflow) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}

function rowToProcedure(row: ProcedureRow): Procedure {
  return {
    id: row.id,
    activation: row.activation,
    steps: parseSteps(row.steps),
    tags: parseTags(row.tags),
    status: row.status === "deprecated" ? "deprecated" : "active",
    successCount: row.success_count,
    failureCount: row.failure_count,
    useCount: row.use_count,
    voteScore: typeof row.vote_score === "number" ? row.vote_score : 0,
    parentLessonIds: parseIdList(row.parent_lesson_ids),
    parentMemoryIds: parseIdList(row.parent_memory_ids),
    source: row.source === "manual" ? "manual" : "consolidator",
    workingDir: row.working_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deprecatedAt: row.deprecated_at,
  };
}

/**
 * Combined ranking helper for `### procedures`. Same shape as
 * `computeLessonCombinedScore`; exported so the renderer can clip
 * its pointer list deterministically (scenario 7b.E.3).
 */
export function computeProcedureCombinedScore(
  proc: Pick<Procedure, "voteScore" | "successCount" | "failureCount">,
  scoreBlend: number,
): number {
  const blend = Math.max(0, Math.min(1, scoreBlend));
  return (
    blend * proc.voteScore +
    (1 - blend) * (proc.successCount - proc.failureCount)
  );
}

function parseSteps(raw: string): ProcedureStep[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is { description: unknown; toolHint?: unknown } =>
          typeof entry === "object" && entry !== null,
      )
      .map((entry) => ({
        description:
          typeof entry.description === "string" ? entry.description : "",
        toolHint:
          typeof entry.toolHint === "string" && entry.toolHint.length > 0
            ? entry.toolHint
            : null,
      }))
      .filter((step) => step.description.length > 0);
  } catch {
    return [];
  }
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

function parseIdList(raw: string): number[] {
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
    throw new ProcedureValidationError(
      "activation",
      "activation must be a string",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ProcedureValidationError(
      "activation",
      "activation must be non-empty",
    );
  }
  if (trimmed.length > PROCEDURE_ACTIVATION_MAX_LENGTH) {
    throw new ProcedureValidationError(
      "activation",
      `activation must be at most ${PROCEDURE_ACTIVATION_MAX_LENGTH} chars`,
    );
  }
  return trimmed;
}

function validateSteps(raw: readonly ProcedureStep[]): ProcedureStep[] {
  if (!Array.isArray(raw)) {
    throw new ProcedureValidationError("steps", "steps must be an array");
  }
  if (raw.length < PROCEDURE_MIN_STEPS) {
    throw new ProcedureValidationError(
      "steps",
      `steps must contain at least ${PROCEDURE_MIN_STEPS} entries`,
    );
  }
  if (raw.length > PROCEDURE_MAX_STEPS) {
    throw new ProcedureValidationError(
      "steps",
      `steps must contain at most ${PROCEDURE_MAX_STEPS} entries`,
    );
  }
  const out: ProcedureStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new ProcedureValidationError(
        "steps",
        "every step must be an object",
      );
    }
    const desc = (entry as ProcedureStep).description;
    if (typeof desc !== "string") {
      throw new ProcedureValidationError(
        "steps",
        "every step needs a string description",
      );
    }
    const trimmedDesc = desc.trim();
    if (trimmedDesc.length === 0) {
      throw new ProcedureValidationError(
        "steps",
        "step description must be non-empty",
      );
    }
    if (trimmedDesc.length > PROCEDURE_DESCRIPTION_MAX_LENGTH) {
      throw new ProcedureValidationError(
        "steps",
        `step description must be at most ${PROCEDURE_DESCRIPTION_MAX_LENGTH} chars`,
      );
    }
    const rawHint = (entry as ProcedureStep).toolHint;
    let toolHint: string | null = null;
    if (typeof rawHint === "string" && rawHint.trim().length > 0) {
      const trimmedHint = rawHint.trim();
      if (trimmedHint.length > PROCEDURE_TOOL_HINT_MAX_LENGTH) {
        throw new ProcedureValidationError(
          "steps",
          `step toolHint must be at most ${PROCEDURE_TOOL_HINT_MAX_LENGTH} chars`,
        );
      }
      if (!TOOL_HINT_PATTERN.test(trimmedHint)) {
        throw new ProcedureValidationError(
          "steps",
          `step toolHint must match ${TOOL_HINT_PATTERN}`,
        );
      }
      toolHint = trimmedHint;
    }
    out.push({ description: trimmedDesc, toolHint });
  }
  return out;
}

function validateTags(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (trimmed.length > PROCEDURE_TAG_MAX_LENGTH) continue;
    if (!TAG_PATTERN.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= PROCEDURE_MAX_TAGS) break;
  }
  return out;
}

function validateParentIds(
  raw: readonly number[],
  field: "parentLessonIds" | "parentMemoryIds",
): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProcedureValidationError(
      field,
      `${field} must contain at least one id`,
    );
  }
  const out: number[] = [];
  for (const id of raw) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ProcedureValidationError(
        field,
        `every ${field} entry must be a positive integer`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function validateProcedureId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new ProcedureValidationError(
      "id",
      "procedure id must be a positive integer",
    );
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

function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
