/**
 * Argument parsing for `fusion.delegate`.
 *
 * The orchestrator is a cloud model writing free-form JSON, so this is
 * the one place that decides what a fan-out request may look like. It
 * is deliberately strict and returns a *sentence* rather than throwing:
 * a malformed delegation should cost the orchestrator one tool result
 * it can read and fix, not a failed turn.
 *
 * One tool result, not three (F44). The parser used to stop at the
 * first problem it met, and a local orchestrator at ~5 tok/s paid for
 * that in whole minutes: three consecutive calls refused — a stray key,
 * then a missing `title` on every task, then one unmatched `requires`
 * name — each ~4–5 minutes of generation, before a single worker ran.
 * Every problem of a call is now collected and reported in one message
 * (`validation: tasks[0].instructions …; tasks[2].files[1] …;
 * contract.requires[1] …`), so the model regenerates once with the whole
 * list in front of it. Three of the four refusals seen that afternoon
 * no longer happen at all: `title` defaults to the id (a label is not
 * worth a regeneration), and an unmatched `requires` or a `provides`
 * entry with nowhere to be looked for are warnings carried to the
 * workers and the result (`contractWarnings` in `contract.ts`). What
 * still refuses is what cannot run — no tasks, empty `instructions`, a
 * limit exceeded, a wrong type — and the unknown-top-level-key refusal
 * that sits in front of every tool (F40).
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

import {
  CONTRACT_PROVIDE_KINDS,
  MAX_PROVIDE_SHAPE_CHARS,
  MAX_CONTRACT_CHECKS,
  MAX_CONTRACT_PROVIDES,
  MAX_CONTRACT_RENDERED_CHARS,
  contractWarnings,
  renderContractBlock,
  type ContractCheck,
  type ContractProvide,
  type ContractProvideKind,
  type ContractRequire,
  type ContractTaskFiles,
  type DelegateContract,
} from "./contract.js";
import { readContractInputs } from "./contract-inputs.js";

/** One unit of delegated work; becomes exactly one worker turn. */
export interface DelegateTask {
  /** Orchestrator-chosen id, unique within the call. Echoed in the output. */
  id: string;
  /**
   * One-line label. Shown to the operator in the progress feed and on
   * the status table. Optional on the wire: a call that leaves it out
   * (or sends something that is not a non-empty string) gets the id,
   * humanised (`humaniseTaskId`), so every renderer has a label and no
   * call is refused over one.
   */
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
  /**
   * Step budget for THIS task, when the orchestrator judges it needs
   * more than the install's default. Clamped at the runner against a
   * multiple of the configured default — see
   * `WORKER_BUDGET_CEILING_FACTOR`. Absent means the default.
   */
  maxSteps?: number;
  /**
   * Wall-time budget for THIS task, same rules as `maxSteps`. It is the
   * budget for the WORK: the wait for a server slot is bounded
   * separately and does not spend it.
   */
  timeoutMs?: number;
}

export type ParsedDelegateArgs =
  | {
      ok: true;
      tasks: DelegateTask[];
      maxWorkers?: number;
      contract?: DelegateContract;
    }
  | { ok: false; error: string };

/**
 * Fan-out width ceiling. Sixteen, not eight: `maxWorkers` is
 * deliberately unbounded (the machine's slots are the real limit), so
 * this constant was the one thing actually capping how wide a plan
 * could be, and it capped it below what a 2-slot machine can work
 * through in waves.
 */
export const MAX_DELEGATE_TASKS = 16;
export const MAX_INSTRUCTIONS_CHARS = 32_000;
export const MAX_TASK_FILES = 32;
/**
 * How many problems one refusal spells out before it says "and N more".
 * Bounds a hostile call (a thousand malformed `requires` entries), not a
 * real one: eight tasks with every field wrong still fit under it.
 */
export const MAX_REPORTED_PROBLEMS = 32;

/** `8436` → `"8,436"`: the number the orchestrator has to act on, readable. */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * `fix_main_sync` → `fix main sync`: the id as a label, for a task that
 * named no title. Underscores and hyphens become spaces; anything else
 * is kept as written, because the id is what the orchestrator will use
 * to refer to the task and the label should still read as that id.
 */
export function humaniseTaskId(id: string): string {
  const spaced = id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.length > 0 ? spaced : id;
}

function fail(error: string): ParsedDelegateArgs {
  return { ok: false, error: `validation: ${error}` };
}

/** Every collected problem in one sentence, capped for a hostile call. */
function failAll(problems: readonly string[]): ParsedDelegateArgs {
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
  const rest = problems.length - shown.length;
  return fail(
    shown.join("; ") +
      (rest > 0 ? `; … and ${rest} more problem${rest === 1 ? "" : "s"}` : ""),
  );
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A per-task budget override. Out-of-range is CLAMPED at the runner, not
 * refused here: a number that is too big is the orchestrator's estimate
 * of the work, not a malformed call, and refusing it would cost a whole
 * regeneration to fix one integer. Only a value that is not a positive
 * finite number at all is a validation problem.
 */
function readBudget(
  value: unknown,
  label: string,
  problems: string[],
): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    problems.push(`${label} must be a positive number`);
    return null;
  }
  return Math.floor(n);
}

/**
 * The task's `files`, every bad entry named by its index so the model
 * fixes them all in the one regeneration it pays for.
 */
function readFiles(
  value: unknown,
  taskLabel: string,
  problems: string[],
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${taskLabel}.files must be an array of strings`);
    return [];
  }
  if (value.length > MAX_TASK_FILES) {
    problems.push(
      `${taskLabel}.files has ${value.length} entries; at most ${MAX_TASK_FILES}`,
    );
    return [];
  }
  const out: string[] = [];
  for (const [j, entry] of value.entries()) {
    const path = readString(entry);
    if (path === null) {
      problems.push(`${taskLabel}.files[${j}] must be a non-empty string`);
      continue;
    }
    out.push(path);
  }
  return out;
}

function readMaxWorkers(value: unknown, problems: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push("maxWorkers must be a number");
    return null;
  }
  const n = Math.trunc(value);
  if (n < 1) {
    problems.push("maxWorkers must be at least 1");
    return null;
  }
  return n;
}

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
function readJsonArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What the contract binds: the ids that parsed, and their declared files. */
type BindableTask = ContractTaskFiles & Pick<DelegateTask, "id">;

/**
 * Validate `contract` against the tasks it binds, collecting every
 * problem by field. A broken entry is named and skipped; the rest of
 * the contract is still checked, so one regeneration can fix it all.
 *
 * Only shape is a problem here — a wrong type, an unknown task id, a
 * limit. What the contract *means* is never refused: a `requires` name
 * no `provides` entry matches, or a non-file provide with nowhere to
 * be looked for, are carried through as declared and stored on the
 * contract as `warnings` (`contractWarnings`), because nothing about
 * either stops the workers from running.
 */
function readContract(
  raw: unknown,
  tasks: readonly BindableTask[],
  problems: string[],
): DelegateContract | undefined {
  const value = readJsonArg(raw);
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    problems.push("contract must be an object");
    return undefined;
  }
  const ids = new Set(tasks.map((t) => t.id));
  const known = (task: unknown, field: string): string | null => {
    const id = readString(task);
    if (id === null) return `${field} must be a task id`;
    if (!ids.has(id)) return `${field} names unknown task "${id}"`;
    return null;
  };
  const contract: DelegateContract = {};

  const inputs = readContractInputs(value.inputs, problems);
  if (inputs !== undefined) contract.inputs = inputs;

  if (value.owners !== undefined && value.owners !== null) {
    if (!isRecord(value.owners)) {
      problems.push("contract.owners must be an object of { path: taskId }");
    } else {
      const owners: Record<string, string> = {};
      for (const [path, task] of Object.entries(value.owners)) {
        const key = path.trim();
        if (key.length === 0) {
          problems.push("contract.owners has an empty path");
          continue;
        }
        const bad = known(task, `contract.owners["${key}"]`);
        if (bad !== null) {
          problems.push(bad);
          continue;
        }
        owners[key] = (task as string).trim();
      }
      if (Object.keys(owners).length > 0) contract.owners = owners;
    }
  }

  if (value.provides !== undefined && value.provides !== null) {
    if (!Array.isArray(value.provides)) {
      problems.push(
        "contract.provides must be an array of { task, kind, name, in?, shape? }",
      );
    } else if (value.provides.length > MAX_CONTRACT_PROVIDES) {
      problems.push(
        `contract.provides has ${value.provides.length} entries; at most ${MAX_CONTRACT_PROVIDES}`,
      );
    } else {
      const provides: ContractProvide[] = [];
      for (let i = 0; i < value.provides.length; i += 1) {
        const entry: unknown = value.provides[i];
        const label = `contract.provides[${i}]`;
        if (!isRecord(entry)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        const before = problems.length;
        const bad = known(entry.task, `${label}.task`);
        if (bad !== null) problems.push(bad);
        const kind = readString(entry.kind);
        if (
          kind === null ||
          !(CONTRACT_PROVIDE_KINDS as readonly string[]).includes(kind)
        ) {
          problems.push(
            `${label}.kind must be one of ${CONTRACT_PROVIDE_KINDS.join(", ")}`,
          );
        }
        const name = readString(entry.name);
        if (name === null) {
          problems.push(`${label}.name must be a non-empty string`);
        }
        const inPath =
          entry.in === undefined || entry.in === null
            ? null
            : readString(entry.in);
        if (entry.in !== undefined && entry.in !== null && inPath === null) {
          problems.push(`${label}.in must be a non-empty path`);
        }
        const rawShape =
          entry.shape === undefined || entry.shape === null
            ? null
            : readString(entry.shape);
        if (entry.shape !== undefined && entry.shape !== null && rawShape === null) {
          problems.push(`${label}.shape must be a non-empty string`);
        }
        // Truncated, not refused: an over-long shape is a model being
        // wordy about something real, and losing the whole call over it
        // costs a regeneration. The first line is the signature anyway.
        const shape =
          rawShape === null
            ? null
            : rawShape.length > MAX_PROVIDE_SHAPE_CHARS
              ? `${rawShape.slice(0, MAX_PROVIDE_SHAPE_CHARS - 1)}…`
              : rawShape;
        if (problems.length > before || kind === null || name === null) {
          continue;
        }
        provides.push({
          task: (entry.task as string).trim(),
          kind: kind as ContractProvideKind,
          name,
          ...(inPath === null ? {} : { in: inPath }),
          ...(shape === null ? {} : { shape }),
        });
      }
      if (provides.length > 0) contract.provides = provides;
    }
  }

  if (value.requires !== undefined && value.requires !== null) {
    if (!Array.isArray(value.requires)) {
      problems.push("contract.requires must be an array of { task, name }");
    } else {
      const requires: ContractRequire[] = [];
      for (let i = 0; i < value.requires.length; i += 1) {
        const entry: unknown = value.requires[i];
        const label = `contract.requires[${i}]`;
        if (!isRecord(entry)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        const before = problems.length;
        const bad = known(entry.task, `${label}.task`);
        if (bad !== null) problems.push(bad);
        const name = readString(entry.name);
        if (name === null) {
          problems.push(`${label}.name must be a non-empty string`);
        }
        if (problems.length > before || name === null) continue;
        requires.push({ task: (entry.task as string).trim(), name });
      }
      if (requires.length > 0) contract.requires = requires;
    }
  }

  if (value.checks !== undefined && value.checks !== null) {
    if (!Array.isArray(value.checks)) {
      problems.push("contract.checks must be an array of verify.run specs");
    } else if (value.checks.length > MAX_CONTRACT_CHECKS) {
      problems.push(
        `contract.checks has ${value.checks.length} entries; at most ${MAX_CONTRACT_CHECKS}`,
      );
    } else {
      const checks: ContractCheck[] = [];
      for (let i = 0; i < value.checks.length; i += 1) {
        const entry: unknown = value.checks[i];
        const label = `contract.checks[${i}]`;
        if (!isRecord(entry)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        const { task, ...spec } = entry;
        if (Object.keys(spec).length === 0) {
          problems.push(`${label} carries no verify.run arguments`);
          continue;
        }
        if (task === undefined || task === null) {
          checks.push(spec);
          continue;
        }
        const bad = known(task, `${label}.task`);
        if (bad !== null) {
          problems.push(bad);
          continue;
        }
        checks.push({ task: (task as string).trim(), ...spec });
      }
      if (checks.length > 0) contract.checks = checks;
    }
  }

  if (Object.keys(contract).length === 0) return undefined;
  // Stored before the block is measured: the workers pay for these
  // lines like any other.
  const warnings = contractWarnings(contract, tasks);
  if (warnings.length > 0) contract.warnings = warnings;
  const rendered = renderContractBlock(contract).length;
  if (rendered > MAX_CONTRACT_RENDERED_CHARS) {
    const over = rendered - MAX_CONTRACT_RENDERED_CHARS;
    problems.push(
      `contract renders to ${formatCount(rendered)} chars; the limit is ${formatCount(MAX_CONTRACT_RENDERED_CHARS)} — shorten it by at least ${formatCount(over)} chars`,
    );
  }
  return contract;
}

/**
 * Parse and validate `fusion.delegate` args. Never throws; an invalid
 * call comes back as `{ ok: false, error }` for the tool to render as a
 * `status: "error"` result the orchestrator can act on — one error
 * naming every problem of the call, not the first one met.
 *
 * Only the shape of `tasks` itself (not an array, empty, over the cap)
 * ends the parse on its own: there is nothing else to check against
 * and the model has to re-plan, not patch fields.
 */
export function parseDelegateArgs(
  raw: Record<string, unknown>,
): ParsedDelegateArgs {
  const rawTasks = readJsonArg(raw.tasks);
  if (!Array.isArray(rawTasks)) {
    return fail("tasks must be an array of { id, instructions, title? }");
  }
  if (rawTasks.length === 0)
    return fail("tasks must contain at least one task");
  if (rawTasks.length > MAX_DELEGATE_TASKS) {
    return fail(
      `tasks has ${rawTasks.length} entries; at most ${MAX_DELEGATE_TASKS} per call`,
    );
  }

  const problems: string[] = [];
  const tasks: DelegateTask[] = [];
  // Every task whose id parsed, whatever else was wrong with it: the
  // contract is checked against the ids the orchestrator actually
  // wrote, so a task missing its instructions does not also turn every
  // contract entry naming it into an "unknown task" problem.
  const bindable: BindableTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTasks.length; i += 1) {
    const entry = rawTasks[i];
    const label = `tasks[${i}]`;
    if (!isRecord(entry)) {
      problems.push(`${label} must be an object`);
      continue;
    }
    const before = problems.length;
    const id = readString(entry.id);
    if (id === null) problems.push(`${label}.id must be a non-empty string`);
    else if (seen.has(id)) problems.push(`${label}.id "${id}" is not unique`);
    const instructions = readString(entry.instructions);
    if (instructions === null) {
      problems.push(`${label}.instructions must be a non-empty string`);
    } else if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      // The limit AND the overage: a model told only "at most N" cannot
      // count its own output, so it resends something just as long.
      const over = instructions.length - MAX_INSTRUCTIONS_CHARS;
      problems.push(
        `${label}.instructions is ${formatCount(instructions.length)} chars; ` +
          `the limit is ${formatCount(MAX_INSTRUCTIONS_CHARS)} — shorten it by at least ${formatCount(over)} chars. ` +
          `The workers already receive the operator's original request, so do not restate it in the brief.`,
      );
    }
    const files = readFiles(entry.files, label, problems);
    const deliverable = readString(entry.deliverable);
    const maxSteps = readBudget(entry.maxSteps, `${label}.maxSteps`, problems);
    const taskTimeoutMs = readBudget(
      entry.timeoutMs,
      `${label}.timeoutMs`,
      problems,
    );
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      bindable.push({ id, ...(files.length === 0 ? {} : { files }) });
    }
    if (problems.length > before || id === null || instructions === null) {
      continue;
    }
    tasks.push({
      id,
      title: readString(entry.title) ?? humaniseTaskId(id),
      instructions,
      ...(deliverable === null ? {} : { deliverable }),
      ...(files.length === 0 ? {} : { files }),
      ...(maxSteps === null ? {} : { maxSteps }),
      ...(taskTimeoutMs === null ? {} : { timeoutMs: taskTimeoutMs }),
    });
  }

  const maxWorkers = readMaxWorkers(raw.maxWorkers, problems);
  const contract = readContract(raw.contract, bindable, problems);
  if (problems.length > 0) return failAll(problems);
  return {
    ok: true,
    tasks,
    ...(maxWorkers === null ? {} : { maxWorkers }),
    ...(contract === undefined ? {} : { contract }),
  };
}
