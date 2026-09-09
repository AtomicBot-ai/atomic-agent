/**
 * Argument parsing for `fusion.delegate`.
 *
 * The orchestrator is a cloud model writing free-form JSON, so this is
 * the one place that decides what a fan-out request may look like. It
 * is deliberately strict and returns a *sentence* rather than throwing:
 * a malformed delegation should cost the orchestrator one tool result
 * it can read and fix, not a failed turn.
 *
 * The caps are not style — each one bounds a real resource. Task count
 * bounds how many local turns one call can start, `instructions` bounds
 * the worker's prompt, `files` bounds the paths pasted into it, and
 * `maxWorkers` bounds the concurrency the pool is asked for.
 */

/** One unit of delegated work; becomes exactly one worker turn. */
export interface DelegateTask {
  /** Orchestrator-chosen id, unique within the call. Echoed in the output. */
  id: string;
  /** One-line label. Shown to the operator in the progress feed. */
  title: string;
  /** The self-contained brief. The worker has no other context. */
  instructions: string;
  /** What the worker should hand back (format, shape, acceptance). */
  deliverable?: string;
  /** Paths the worker should start from. */
  files?: string[];
}

export type ParsedDelegateArgs =
  | { ok: true; tasks: DelegateTask[]; maxWorkers?: number }
  | { ok: false; error: string };

export const MAX_DELEGATE_TASKS = 8;
export const MAX_DELEGATE_WORKERS = 8;
export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_TASK_FILES = 32;

function fail(error: string): ParsedDelegateArgs {
  return { ok: false, error: `validation: ${error}` };
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFiles(value: unknown, taskLabel: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${taskLabel}.files must be an array of strings`;
  if (value.length > MAX_TASK_FILES) {
    return `${taskLabel}.files has ${value.length} entries; at most ${MAX_TASK_FILES}`;
  }
  const out: string[] = [];
  for (const entry of value) {
    const path = readString(entry);
    if (path === null) return `${taskLabel}.files must contain non-empty strings`;
    out.push(path);
  }
  return out;
}

function readMaxWorkers(value: unknown): number | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "maxWorkers must be a number";
  }
  const n = Math.trunc(value);
  if (n < 1 || n > MAX_DELEGATE_WORKERS) {
    return `maxWorkers must be between 1 and ${MAX_DELEGATE_WORKERS}`;
  }
  return n;
}

/**
 * Parse and validate `fusion.delegate` args. Never throws; an invalid
 * call comes back as `{ ok: false, error }` for the tool to render as a
 * `status: "error"` result the orchestrator can act on.
 */
export function parseDelegateArgs(raw: Record<string, unknown>): ParsedDelegateArgs {
  const rawTasks = raw.tasks;
  if (!Array.isArray(rawTasks)) {
    return fail("tasks must be an array of { id, title, instructions }");
  }
  if (rawTasks.length === 0) return fail("tasks must contain at least one task");
  if (rawTasks.length > MAX_DELEGATE_TASKS) {
    return fail(
      `tasks has ${rawTasks.length} entries; at most ${MAX_DELEGATE_TASKS} per call`,
    );
  }

  const tasks: DelegateTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTasks.length; i += 1) {
    const entry = rawTasks[i];
    const label = `tasks[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return fail(`${label} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = readString(record.id);
    if (id === null) return fail(`${label}.id must be a non-empty string`);
    if (seen.has(id)) return fail(`${label}.id "${id}" is not unique`);
    seen.add(id);
    const title = readString(record.title);
    if (title === null) return fail(`${label}.title must be a non-empty string`);
    const instructions = readString(record.instructions);
    if (instructions === null) {
      return fail(`${label}.instructions must be a non-empty string`);
    }
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      return fail(
        `${label}.instructions is ${instructions.length} chars; at most ${MAX_INSTRUCTIONS_CHARS}`,
      );
    }
    const files = readFiles(record.files, label);
    if (typeof files === "string") return fail(files);
    const deliverable = readString(record.deliverable);
    tasks.push({
      id,
      title,
      instructions,
      ...(deliverable === null ? {} : { deliverable }),
      ...(files.length === 0 ? {} : { files }),
    });
  }

  const maxWorkers = readMaxWorkers(raw.maxWorkers);
  if (typeof maxWorkers === "string") return fail(maxWorkers);
  return {
    ok: true,
    tasks,
    ...(maxWorkers === null ? {} : { maxWorkers }),
  };
}
