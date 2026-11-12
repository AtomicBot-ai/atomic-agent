/**
 * ATO-1102: the "Test skill" button on a skill card runs the agent's own
 * `atag skill eval <name> --tasks <file> --json` (ATO-1098, task-set format
 * ATO-1099): every task once with the skill and once without it.
 *
 * This file is pure: the probe, the argv and the output parsing.
 * skill-eval-ipc.ts runs the commands.
 *
 * Aligned with #1307 (src/cli/skill-eval-command.ts, src/skills/eval/README.md).
 * `--json` prints the whole result document to stdout; the CLI also saves it to
 * `<stateDir>/skill-evals/<skill>/<runId>.json` and writes `saved: <path>` to stderr.
 * It exits 0 when every planned run finished, 1 when it was stopped (SIGTERM
 * included: it still prints and saves what ran). Approval requests are refused
 * by default; the app never passes `--no-approval`.
 *
 * The button only appears when both hold:
 *  - the agent's `skill --help` lists an `eval` subcommand (an older agent
 *    answers `unknown subcommand: eval`, so no button instead of an error);
 *  - the skill has a task set next to its SKILL.md (`tasks.yaml`, `tasks.yml` or `tasks.json`).
 */
import { dirname, join } from "node:path";

/** `SKILL_NAME_RE` in agent-cli.ts. */
export const SKILL_EVAL_NAME_RE = /^[\w.-]{1,64}$/;

/**
 * Task-set file names looked for beside SKILL.md, in this order. `skill eval`
 * takes any path (YAML, or JSON, which also parses); beside SKILL.md is where the
 * app looks, so a skill carries its own task set.
 */
export const SKILL_EVAL_TASK_FILES = ["tasks.yaml", "tasks.yml", "tasks.json"] as const;

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

/**
 * One variant of the run, read from the result document's `summary.with` /
 * `summary.without` (`SkillEvalVariantSummary` in src/skills/eval/eval-result.ts).
 */
export interface SkillEvalSide {
  runs: number;
  passed: number;
  /** passed / runs, 0..1. */
  accuracy: number;
  /** Mean wall time of one run, seconds. */
  secondsMean: number;
  /** Null when the provider reported no usage. */
  tokens: number | null;
  /** 0 on a local model, null when nothing priced the run. */
  costUsd: number | null;
  /** Runs that ended in an error, a timeout or a failure. */
  errors: number;
}

/** `summary.delta`: with minus without. */
export interface SkillEvalDelta {
  accuracy: number;
  secondsMean: number;
  tokens: number | null;
  costUsd: number | null;
}

export interface SkillEvalTaskRow {
  taskId: string;
  with: { passed: number; runs: number } | null;
  without: { passed: number; runs: number } | null;
}

/** What the window gets: the part of the result document the card shows. */
export interface SkillEvalResult {
  skill: string;
  runId: string | null;
  /** False when the eval stopped before every planned run finished. */
  complete: boolean;
  repeat: number;
  with: SkillEvalSide;
  without: SkillEvalSide;
  delta: SkillEvalDelta | null;
  perTask: SkillEvalTaskRow[];
  /** Approval requests the eval refused (approvals are denied by default). */
  approvalsDenied: number;
}

export type SkillEvalAnswer = { ok: true; result: SkillEvalResult; savedPath: string | null } | { ok: false; error: string };

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const signedAmount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function side(raw: unknown): SkillEvalSide | null {
  const r = obj(raw);
  if (!r) return null;
  const runs = count(r.runs), passed = count(r.passed);
  if (runs === null || passed === null || passed > runs) return null;
  const accuracy = amount(r.accuracy);
  return {
    runs,
    passed,
    accuracy: accuracy !== null && accuracy <= 1 ? accuracy : runs ? passed / runs : 0,
    secondsMean: (amount(r.wallMsMean) ?? 0) / 1000,
    tokens: amount(r.totalTokens),
    costUsd: amount(r.costUsd),
    errors: count(r.errors) ?? 0,
  };
}

function taskSide(raw: unknown): { passed: number; runs: number } | null {
  const r = obj(raw);
  if (!r) return null;
  const runs = count(r.runs), passed = count(r.passed);
  return runs === null || passed === null || passed > runs ? null : { passed, runs };
}

/** The JSON document in stdout. `--json` prints it pretty-printed as the whole of stdout. */
function jsonDoc(stdout: string): unknown {
  const whole = stdout.trim();
  const at = whole.indexOf("{");
  if (at < 0) return undefined;
  try {
    return JSON.parse(at === 0 ? whole : whole.slice(at));
  } catch {
    return undefined;
  }
}

/** `saved: <path>`, the line `skill eval` writes to stderr after saving the result file. */
export function skillEvalSavedPath(stderr: string): string | null {
  const m = /^saved: (.+)$/m.exec(stderr);
  return m ? m[1]!.trim() : null;
}

/** Parse `atag skill eval … --json` (the `atomic-agent.skill-eval/1` result document). */
export function parseSkillEvalOutput(stdout: string, name: string, stderr = ""): SkillEvalAnswer {
  const d = obj(jsonDoc(stdout));
  const summary = d && obj(d.summary);
  if (!d || !summary) return { ok: false, error: "The agent did not report a test result." };
  if (typeof d.schema === "string" && !d.schema.startsWith("atomic-agent.skill-eval/")) {
    return { ok: false, error: "The test result could not be read." };
  }
  const withSide = side(summary.with), withoutSide = side(summary.without);
  if (!withSide || !withoutSide) return { ok: false, error: "The test did not run both with and without the skill." };
  const rd = obj(summary.delta);
  const delta: SkillEvalDelta | null = rd && signedAmount(rd.accuracy) !== null
    ? {
        accuracy: signedAmount(rd.accuracy)!,
        secondsMean: (signedAmount(rd.wallMsMean) ?? 0) / 1000,
        tokens: signedAmount(rd.totalTokens),
        costUsd: signedAmount(rd.costUsd),
      }
    : null;
  const perTask = Array.isArray(summary.perTask)
    ? summary.perTask
        .map(obj)
        .filter((t): t is Record<string, unknown> => !!t && typeof t.taskId === "string")
        .map((t) => ({ taskId: t.taskId as string, with: taskSide(t.with), without: taskSide(t.without) }))
    : [];
  const skill = obj(d.skill);
  const options = obj(d.options);
  const runs = Array.isArray(d.runs) ? d.runs.map(obj) : [];
  return {
    ok: true,
    savedPath: skillEvalSavedPath(stderr),
    result: {
      skill: skill && typeof skill.name === "string" && skill.name ? skill.name : name,
      runId: typeof d.runId === "string" ? d.runId : null,
      complete: d.complete !== false,
      repeat: (options && count(options.repeat)) || 1,
      with: withSide,
      without: withoutSide,
      delta,
      perTask,
      approvalsDenied: runs.reduce((sum, r) => sum + ((r && count(r.approvalsDenied)) || 0), 0),
    },
  };
}
