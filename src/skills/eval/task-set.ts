import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Skill Lab task sets (ATO-1099): a YAML (or JSON) file of tasks the agent
 * runs with a skill and without it. Each task carries a prompt and one or
 * more checks; every check must pass for the run to count as passed.
 * The format is documented in README.md next to this file.
 */

/** Wall-clock ceiling for one task run, unless the file says otherwise. */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
/** Ceiling for one `command` check. */
export const DEFAULT_COMMAND_CHECK_TIMEOUT_MS = 60 * 1000;
/** A `judge` check passes at this score (of 5) unless it sets `minScore`. */
export const DEFAULT_JUDGE_MIN_SCORE = 4;

export type SkillEvalCheck =
  | {
      /** The normalized reply equals `expected` (see `normalizeAnswer`). */
      type: "exact";
      expected: string;
      caseSensitive: boolean;
    }
  | {
      /** `new RegExp(pattern, flags)` matches the raw reply. */
      type: "regex";
      pattern: string;
      flags: string;
    }
  | {
      /**
       * A shell command run in the task's working folder after the agent
       * finished; exit code 0 passes. The reply is on stdin and in the
       * file named by `SKILL_EVAL_ANSWER_FILE`.
       */
      type: "command";
      run: string;
      timeoutMs: number;
    }
  | {
      /**
       * A judge model grades the reply against `rubric` on 1..5 (ATO-1101);
       * passes at `minScore` or above. For answers no pattern can check.
       */
      type: "judge";
      rubric: string;
      /** A model answer the judge compares against; null for none. */
      reference: string | null;
      minScore: number;
    };

export type SkillEvalCheckType = SkillEvalCheck["type"];

export interface SkillEvalTask {
  id: string;
  prompt: string;
  checks: SkillEvalCheck[];
  /** Absolute folder copied into the fresh working folder before the run; null for none. */
  fixturesDir: string | null;
  /** Step ceiling for the run; null keeps the agent's own `agent.task.maxSteps`. */
  maxSteps: number | null;
  timeoutMs: number;
}

export interface SkillEvalTaskSet {
  /** Absolute path of the file the set was read from. */
  sourcePath: string;
  /** `skill:` from the file, when it names the skill it was written for. */
  skill: string | null;
  description: string | null;
  tasks: SkillEvalTask[];
  /** sha256 of the file bytes, so two result files can tell whether they ran the same tasks. */
  sha256: string;
}

export class SkillEvalTaskSetError extends Error {
  constructor(sourcePath: string, message: string) {
    super(`${sourcePath}: ${message}`);
    this.name = "SkillEvalTaskSetError";
  }
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Read and validate a task set file. Throws `SkillEvalTaskSetError` on any problem. */
export async function loadTaskSet(path: string): Promise<SkillEvalTaskSet> {
  const sourcePath = resolve(path);
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillEvalTaskSetError(sourcePath, `cannot read tasks file (${message})`);
  }
  return parseTaskSet(text, sourcePath);
}

/**
 * Validate the text of a task set. `sourcePath` is used for messages and
 * to resolve `fixtures:` folders (relative to the file's folder).
 */
/** Whether any task has a `judge` check, so the CLI knows to set up a judge before running. */
export function taskSetUsesJudge(set: SkillEvalTaskSet): boolean {
  return set.tasks.some((t) => t.checks.some((c) => c.type === "judge"));
}

export function parseTaskSet(text: string, sourcePath: string): SkillEvalTaskSet {
  const fail = (message: string): never => {
    throw new SkillEvalTaskSetError(sourcePath, message);
  };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    fail(`not valid YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw)) return fail("expected a mapping with a `tasks:` list");
  const defaults = raw.defaults === undefined ? {} : raw.defaults;
  if (!isRecord(defaults)) return fail("`defaults` must be a mapping");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) return fail("`tasks` must be a non-empty list");

  const baseDir = dirname(sourcePath);
  const seen = new Set<string>();
  const tasks = raw.tasks.map((entry, index): SkillEvalTask => {
    const where = `tasks[${index}]`;
    if (!isRecord(entry)) return fail(`${where} must be a mapping`);
    const id = entry.id;
    if (typeof id !== "string" || !TASK_ID.test(id)) {
      return fail(`${where}.id must be 1-64 letters, digits, dots, dashes or underscores`);
    }
    if (seen.has(id)) return fail(`duplicate task id: ${id}`);
    seen.add(id);
    if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") {
      return fail(`task ${id}: prompt must be a non-empty string`);
    }
    const rawChecks = entry.checks ?? (entry.check === undefined ? undefined : [entry.check]);
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
      return fail(`task ${id}: needs \`check:\` or a non-empty \`checks:\` list`);
    }
    const checks = rawChecks.map((c, i) => parseCheck(c, `task ${id}: checks[${i}]`, fail, defaults));
    return {
      id,
      prompt: entry.prompt,
      checks,
      fixturesDir: parseFixtures(entry.fixtures ?? defaults.fixtures, baseDir, `task ${id}`, fail),
      maxSteps: optionalPositiveInt(entry.maxSteps ?? defaults.maxSteps, `task ${id}: maxSteps`, fail),
      timeoutMs:
        optionalPositiveInt(entry.timeoutMs ?? defaults.timeoutMs, `task ${id}: timeoutMs`, fail) ??
        DEFAULT_TASK_TIMEOUT_MS,
    };
  });

  const skill = raw.skill;
  if (skill !== undefined && typeof skill !== "string") fail("`skill` must be a string");
  const description = raw.description;
  if (description !== undefined && typeof description !== "string") fail("`description` must be a string");
  return {
    sourcePath,
    skill: typeof skill === "string" ? skill : null,
    description: typeof description === "string" ? description : null,
    tasks,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function parseCheck(
  raw: unknown,
  where: string,
  fail: (message: string) => never,
  defaults: Record<string, unknown>,
): SkillEvalCheck {
  if (!isRecord(raw)) return fail(`${where} must be a mapping`);
  switch (raw.type) {
    case "exact": {
      const expected = raw.expected;
      if (typeof expected !== "string" && typeof expected !== "number") {
        return fail(`${where}: exact needs \`expected\` (a string or number)`);
      }
      if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
        return fail(`${where}: caseSensitive must be true or false`);
      }
      return { type: "exact", expected: String(expected), caseSensitive: raw.caseSensitive === true };
    }
    case "regex": {
      if (typeof raw.pattern !== "string" || raw.pattern === "") return fail(`${where}: regex needs \`pattern\``);
      const flags = raw.flags ?? "";
      if (typeof flags !== "string") return fail(`${where}: flags must be a string`);
      try {
        new RegExp(raw.pattern, flags);
      } catch (err) {
        return fail(`${where}: invalid regex (${err instanceof Error ? err.message : String(err)})`);
      }
      return { type: "regex", pattern: raw.pattern, flags };
    }
    case "command": {
      if (typeof raw.run !== "string" || raw.run.trim() === "") return fail(`${where}: command needs \`run\``);
      const timeoutMs =
        optionalPositiveInt(raw.timeoutMs ?? defaults.checkTimeoutMs, `${where}: timeoutMs`, fail) ??
        DEFAULT_COMMAND_CHECK_TIMEOUT_MS;
      return { type: "command", run: raw.run, timeoutMs };
    }
    case "judge": {
      if (typeof raw.rubric !== "string" || raw.rubric.trim() === "") return fail(`${where}: judge needs \`rubric\``);
      if (raw.reference !== undefined && typeof raw.reference !== "string") return fail(`${where}: reference must be a string`);
      const minScore = raw.minScore ?? DEFAULT_JUDGE_MIN_SCORE;
      if (typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 1 || minScore > 5) {
        return fail(`${where}: minScore must be a whole number from 1 to 5`);
      }
      return { type: "judge", rubric: raw.rubric, reference: typeof raw.reference === "string" ? raw.reference : null, minScore };
    }
    default:
      return fail(`${where}: unknown check type ${JSON.stringify(raw.type)} (use exact, regex, command or judge)`);
  }
}

function parseFixtures(
  raw: unknown,
  baseDir: string,
  where: string,
  fail: (message: string) => never,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") return fail(`${where}: fixtures must be a folder path`);
  if (isAbsolute(raw)) return fail(`${where}: fixtures must be relative to the tasks file`);
  const dir = resolve(baseDir, raw);
  const rel = relative(baseDir, dir);
  if (rel.startsWith("..")) return fail(`${where}: fixtures must stay inside the tasks file's folder`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(`${where}: fixtures folder not found: ${raw}`);
  return dir;
}

function optionalPositiveInt(
  raw: unknown,
  where: string,
  fail: (message: string) => never,
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return fail(`${where} must be a positive integer`);
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
