/**
 * ATO-1102: the "Test skill" button on a skill card runs the agent's own
 * `atag skill eval <name> --tasks <file> --json` (ATO-1098, task-set format
 * ATO-1099): every task once with the skill and once without it.
 *
 * This file is pure: the probe, the argv and the output parsing.
 * skill-eval-ipc.ts runs the commands.
 *
 * The button only appears when both hold:
 *  - the agent's `skill --help` lists an `eval` subcommand (an older agent
 *    answers `unknown subcommand: eval`, so no button instead of an error);
 *  - the skill has a task set next to its SKILL.md (`tasks.yaml` / `tasks.yml`).
 */
import { dirname, join } from "node:path";

/** `SKILL_NAME_RE` in agent-cli.ts. */
export const SKILL_EVAL_NAME_RE = /^[\w.-]{1,64}$/;

/** Task-set file names looked for beside SKILL.md, in this order. */
export const SKILL_EVAL_TASK_FILES = ["tasks.yaml", "tasks.yml"] as const;

/** True when `atag skill --help` lists an `eval` subcommand. */
export function skillEvalSupported(helpText: string): boolean {
  return /^[ \t]{2,}eval\b/m.test(helpText);
}

/** The task set for a skill whose SKILL.md is at `skillMdPath`, or null. */
export function skillEvalTasksFile(skillMdPath: string, exists: (path: string) => boolean): string | null {
  if (!skillMdPath) return null;
  const dir = dirname(skillMdPath);
  for (const name of SKILL_EVAL_TASK_FILES) {
    const file = join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}

/** The argv for one run. Always an array, never a shell string. */
export function skillEvalArgs(name: string, tasksFile: string): string[] {
  return ["skill", "eval", name, "--tasks", tasksFile, "--json"];
}

export interface SkillEvalSide {
  passed: number;
  total: number;
  seconds: number | null;
  tokens: number | null;
}

export interface SkillEvalTask {
  id: string;
  withSkill: boolean | null;
  withoutSkill: boolean | null;
}

export interface SkillEvalResult {
  skill: string;
  withSkill: SkillEvalSide;
  withoutSkill: SkillEvalSide;
  tasks: SkillEvalTask[];
}

export type SkillEvalAnswer = { ok: true; result: SkillEvalResult } | { ok: false; error: string };

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function side(raw: unknown): SkillEvalSide | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const passed = count(r.passed), total = count(r.total);
  if (passed === null || total === null || passed > total) return null;
  return { passed, total, seconds: amount(r.seconds), tokens: amount(r.tokens) };
}

function taskPassed(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { passed?: unknown }).passed === "boolean") {
    return (raw as { passed: boolean }).passed;
  }
  return null;
}

/** The JSON document in stdout: the whole of it, else the last line that starts with `{`. */
function jsonDoc(stdout: string): unknown {
  const whole = stdout.trim();
  if (whole.startsWith("{")) {
    try {
      return JSON.parse(whole);
    } catch {
      /* a log line before or after it: fall through to the line scan */
    }
  }
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Parse `atag skill eval … --json`. */
export function parseSkillEvalOutput(stdout: string, name: string): SkillEvalAnswer {
  const doc = jsonDoc(stdout);
  if (!doc || typeof doc !== "object") return { ok: false, error: "The agent did not report a test result." };
  const d = doc as Record<string, unknown>;
  const withSkill = side(d.withSkill), withoutSkill = side(d.withoutSkill);
  if (!withSkill || !withoutSkill) return { ok: false, error: "The test result could not be read." };
  const tasks = Array.isArray(d.tasks)
    ? d.tasks
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t, i) => ({
          id: typeof t.id === "string" && t.id ? t.id : String(i + 1),
          withSkill: taskPassed(t.withSkill),
          withoutSkill: taskPassed(t.withoutSkill),
        }))
    : [];
  return { ok: true, result: { skill: typeof d.skill === "string" && d.skill ? d.skill : name, withSkill, withoutSkill, tasks } };
}
