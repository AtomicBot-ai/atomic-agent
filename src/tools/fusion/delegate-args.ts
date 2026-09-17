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
 * the worker's prompt, and `files` bounds the paths pasted into it.
 *
 * The `instructions` bound is a ceiling on one prompt section, not an
 * estimate of what fits: the worker's real limit is the context its
 * llama-server slot has, which this parser cannot see. It used to be
 * 8,000 chars, and briefs of 8,436–8,916 chars were rejected in a real
 * run — an orchestrator cannot count characters, so it looped, and every
 * rejected ~9K-token call stayed in its transcript. The worker brief now
 * carries the operator's original request on its own (`worker-prompt.ts`),
 * so an honest brief no longer has to restate the spec, and the bound is
 * set where it only stops a runaway. A brief that is legal here but too
 * big for the slot fails the worker with a "ran out of context" hint
 * (`worker-result.ts`) rather than silently.
 *
 * `maxWorkers` is deliberately NOT one of them. The orchestrator sizes
 * its own fan-out (see `fusion-delegate.ts`), and the width it asks for
 * is bounded downstream by things that physically exist — the task
 * count and the server's request slots. A parser ceiling here would
 * turn "wider than this machine can go" into a failed call the model
 * has to notice and retry, instead of a fan-out that simply runs as
 * wide as it can. Only a nonsense value (below one, not a number) is
 * still a validation error.
 */

/** One unit of delegated work; becomes exactly one worker turn. */
export interface DelegateTask {
  /** Orchestrator-chosen id, unique within the call. Echoed in the output. */
  id: string;
  /** One-line label. Shown to the operator in the progress feed. */
  title: string;
  /**
   * The task's brief. Besides this the worker sees only the operator's
   * original request (quoted as context by `worker-prompt.ts`).
   */
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
export const MAX_INSTRUCTIONS_CHARS = 32_000;
export const MAX_TASK_FILES = 32;

/** `8436` → `"8,436"`: the number the orchestrator has to act on, readable. */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

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
  if (!Array.isArray(value))
    return `${taskLabel}.files must be an array of strings`;
  if (value.length > MAX_TASK_FILES) {
    return `${taskLabel}.files has ${value.length} entries; at most ${MAX_TASK_FILES}`;
  }
  const out: string[] = [];
  for (const entry of value) {
    const path = readString(entry);
    if (path === null)
      return `${taskLabel}.files must contain non-empty strings`;
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
  if (n < 1) return "maxWorkers must be at least 1";
  return n;
}

/**
 * Parse and validate `fusion.delegate` args. Never throws; an invalid
 * call comes back as `{ ok: false, error }` for the tool to render as a
 * `status: "error"` result the orchestrator can act on.
 */
/**
 * The task list, whether it arrived as an array or as JSON in a string.
 *
 * Models hand this argument over as a string often enough to matter: in
 * one observed run, three of seven fan-outs died on
 * `tasks must be an array`, each costing the turn a step and the
 * operator a minute. The value was a perfectly good JSON array with
 * quotes around it — the native-tools layer stringifies a nested
 * structure, or the model writes it that way itself.
 *
 * Rejecting that is pedantry with a cost. Parsing it is two lines, and
 * anything that does not parse to an array still fails exactly as
 * before.
 */
/**
 * Accept a `tasks` argument that arrived as JSON *text* rather than as a
 * JSON array.
 *
 * Not a courtesy: a 12B orchestrator on the text-JSON transport writes
 * `"tasks": "[{...}]"` often enough that a whole run died on
 * `tasks must be an array` — the plan was right, the quoting was not,
 * and refusing it taught the model nothing it could act on. Parsing the
 * string costs one `JSON.parse`; anything that does not parse falls
 * through unchanged and gets the same error it got before.
 */
function readTaskList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseDelegateArgs(
  raw: Record<string, unknown>,
): ParsedDelegateArgs {
  const rawTasks = readTaskList(raw.tasks);
  if (!Array.isArray(rawTasks)) {
    return fail("tasks must be an array of { id, title, instructions }");
  }
  if (rawTasks.length === 0)
    return fail("tasks must contain at least one task");
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
    if (title === null)
      return fail(`${label}.title must be a non-empty string`);
    const instructions = readString(record.instructions);
    if (instructions === null) {
      return fail(`${label}.instructions must be a non-empty string`);
    }
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      // The limit AND the overage: a model told only "at most N" cannot
      // count its own output, so it resends something just as long.
      const over = instructions.length - MAX_INSTRUCTIONS_CHARS;
      return fail(
        `${label}.instructions is ${formatCount(instructions.length)} chars; ` +
          `the limit is ${formatCount(MAX_INSTRUCTIONS_CHARS)} — shorten it by at least ${formatCount(over)} chars. ` +
          `The workers already receive the operator's original request, so do not restate it in the brief.`,
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
