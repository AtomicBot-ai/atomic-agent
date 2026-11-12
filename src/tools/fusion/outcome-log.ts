import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { DelegateTask } from "./delegate-args.js";
import { summarizeOutcomes } from "./outcome-summary.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

/**
 * The outcome log (ATO-949): one line per finished worker task, so the
 * planner can learn what works on this machine across runs.
 *
 * Append-only JSONL at `<stateDir>/fusion-outcomes.jsonl`. A row holds
 * numbers and labels only: which leg and model, a size bucket, the
 * status, time, steps, writes and spend. Never the brief, the title,
 * the task id, a path, an error message or a reply: the log describes
 * how a kind of task went, not what it was about.
 *
 * Bounded twice: past `maxBytes` the file is rewritten (temp file +
 * rename) with only its newest rows, at most `maxRows` and at most half
 * of `maxBytes`, so a compaction happens once per few hundred tasks, not
 * on every append. Every read and write is best-effort and never
 * throws: a log that cannot be written must never fail a fan-out.
 */

export const FUSION_OUTCOMES_FILE_NAME = "fusion-outcomes.jsonl";
export const OUTCOME_LOG_MAX_BYTES = 512 * 1024;
export const OUTCOME_LOG_MAX_ROWS = 2_000;
/** How many of the newest rows the summary reads. */
export const OUTCOME_SUMMARY_WINDOW = 300;

const OUTCOME_ROW_VERSION = 1;
const MODEL_CHARS = 80;

/** A coarse size of the task as briefed: what the planner can act on. */
export type OutcomeSize = "small" | "medium" | "large";

export interface FusionOutcomeRow {
  v: number;
  /** Epoch ms the task finished. */
  at: number;
  leg: "local" | "cloud";
  model: string;
  /** The role that picked the model (ATO-943), when one did. */
  role?: string;
  size: OutcomeSize;
  /** Length of the brief (instructions + deliverable), never its text. */
  briefChars: number;
  /** How many starting files the task declared. */
  files: number;
  status: WorkerTaskStatus;
  durationMs: number;
  steps: number;
  writes: number;
  /** Generated tokens, when the provider reported usage. */
  outputTokens?: number;
  /** Priced spend, `null` when no price is known (a local leg). */
  costUsd: number | null;
}

/**
 * `large` from 6000 brief characters or 5 declared files, `small` under
 * 1500 characters with at most one file, `medium` in between. A proxy:
 * the runtime knows the brief before the worker starts, and the planner
 * writes the brief, so a fact about a size is a fact it can act on.
 */
export function outcomeSize(briefChars: number, files: number): OutcomeSize {
  if (briefChars >= 6_000 || files >= 5) return "large";
  if (briefChars < 1_500 && files <= 1) return "small";
  return "medium";
}

/** A model label safe for a one-line prompt fact. */
export function cleanModelLabel(model: string): string {
  const flat = model.replace(/[`\r\n\t]+/g, " ").trim();
  return flat.length > MODEL_CHARS ? flat.slice(0, MODEL_CHARS) : flat;
}

/** The row for one finished task: counts and labels only. */
export function outcomeRowFor(input: {
  result: WorkerTaskResult;
  task: DelegateTask | undefined;
  leg: "local" | "cloud";
  model: string;
  costUsd: number | null;
  at: number;
}): FusionOutcomeRow {
  const { result, task } = input;
  const briefChars =
    (task?.instructions.length ?? 0) + (task?.deliverable?.length ?? 0);
  const files = task?.files?.length ?? 0;
  const outputTokens = result.usage?.completionTokens;
  return {
    v: OUTCOME_ROW_VERSION,
    at: input.at,
    leg: input.leg,
    model: cleanModelLabel(result.model ?? input.model),
    ...(result.modelRole === undefined ? {} : { role: result.modelRole }),
    size: outcomeSize(briefChars, files),
    briefChars,
    files,
    status: result.status,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    steps: result.stepCount,
    writes: result.tools.writes,
    ...(typeof outputTokens === "number" && Number.isFinite(outputTokens)
      ? { outputTokens }
      : {}),
    costUsd:
      input.costUsd !== null && Number.isFinite(input.costUsd)
        ? input.costUsd
        : null,
  };
}

const STATUSES: ReadonlySet<string> = new Set<WorkerTaskStatus>([
  "ok",
  "no_changes",
  "failed",
  "cancelled",
  "needs_orchestrator",
  "max_steps",
  "timeout",
  "queued",
]);

/** A parsed line, or `null` for anything that is not a row we wrote. */
export function parseOutcomeRow(line: string): FusionOutcomeRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<FusionOutcomeRow>;
  if (
    row.v !== OUTCOME_ROW_VERSION ||
    (row.leg !== "local" && row.leg !== "cloud") ||
    typeof row.model !== "string" ||
    row.model.length === 0 ||
    (row.size !== "small" && row.size !== "medium" && row.size !== "large") ||
    typeof row.status !== "string" ||
    !STATUSES.has(row.status) ||
    typeof row.durationMs !== "number" ||
    !Number.isFinite(row.durationMs) ||
    typeof row.at !== "number"
  ) {
    return null;
  }
  return row as FusionOutcomeRow;
}

export interface FusionOutcomeLogOptions {
  path: string;
  maxBytes?: number;
  maxRows?: number;
  summaryWindow?: number;
}

export class FusionOutcomeLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private readonly summaryWindow: number;
  private summary: readonly string[] | undefined;

  constructor(options: FusionOutcomeLogOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? OUTCOME_LOG_MAX_BYTES;
    this.maxRows = options.maxRows ?? OUTCOME_LOG_MAX_ROWS;
    this.summaryWindow = options.summaryWindow ?? OUTCOME_SUMMARY_WINDOW;
  }

  /** Append one row; compacts when the file passed `maxBytes`. Never throws. */
  append(row: FusionOutcomeRow): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(row)}\n`, "utf8");
      if (statSync(this.path).size > this.maxBytes) this.compact();
    } catch {
      // Best-effort: the fan-out goes on without its log line.
    }
  }

  /** The newest valid rows, oldest first, at most `limit`. Never throws. */
  read(limit: number = this.maxRows): FusionOutcomeRow[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const rows: FusionOutcomeRow[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const row = parseOutcomeRow(line);
      if (row !== null) rows.push(row);
    }
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }

  /**
   * The facts the `### fusion` block states, read once per process and
   * then held: those bytes sit in the KV-cache-hot stable prefix, so a
   * fan-out mid-session must not move them. The next process reads the
   * rows this one appended.
   */
  summaryLines(): readonly string[] {
    if (this.summary === undefined) {
      this.summary = summarizeOutcomes(this.read(this.summaryWindow));
    }
    return this.summary;
  }

  private compact(): void {
    const rows = this.read(this.maxRows);
    const budget = Math.floor(this.maxBytes / 2);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const line = `${JSON.stringify(rows[i])}\n`;
      const size = Buffer.byteLength(line, "utf8");
      if (bytes + size > budget) break;
      kept.push(line);
      bytes += size;
    }
    kept.reverse();
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, kept.join(""), "utf8");
    renameSync(tmp, this.path);
  }
}
