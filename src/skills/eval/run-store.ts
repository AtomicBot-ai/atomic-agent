import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SKILL_EVAL_RESULT_SCHEMA, type SkillEvalResult } from "./eval-result.js";

/** Folder under the agent's state folder (`~/.atomic-agent`) that holds Skill Lab results. */
export const SKILL_EVALS_DIR_NAME = "skill-evals";

/** `<stateDir>/skill-evals/<skill>/`. Plugin skills (`plugin:skill`) keep a filesystem-safe name. */
export function skillEvalDir(stateDir: string, skill: string): string {
  return join(stateDir, SKILL_EVALS_DIR_NAME, safeName(skill));
}

/**
 * A sortable, filesystem-safe run id: the start time in UTC with `:` and
 * `.` replaced, e.g. `2026-11-12T09-30-00-000Z`. Newest sorts last.
 */
export function makeRunId(startedAt: Date): string {
  return startedAt.toISOString().replace(/[:.]/g, "-");
}

/** Write one result to `<stateDir>/skill-evals/<skill>/<runId>.json` and return the path. */
export async function saveSkillEvalResult(stateDir: string, result: SkillEvalResult): Promise<string> {
  const dir = skillEvalDir(stateDir, result.skill.name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${result.runId}.json`);
  // Write-then-rename, so a reader polling the folder never sees half a file.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return path;
}

/** Result files of one skill, oldest first. Empty when it was never evaluated. */
export async function listSkillEvalResults(stateDir: string, skill: string): Promise<string[]> {
  const dir = skillEvalDir(stateDir, skill);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(dir, n));
}

/** Read one result file; throws when it is not a Skill Lab result of a known schema. */
export async function readSkillEvalResult(path: string): Promise<SkillEvalResult> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SkillEvalResult>;
  if (parsed.schema !== SKILL_EVAL_RESULT_SCHEMA) {
    throw new Error(`${path}: not a skill eval result (schema ${JSON.stringify(parsed.schema)})`);
  }
  return parsed as SkillEvalResult;
}

/** The newest result of one skill, or null. */
export async function readLatestSkillEvalResult(stateDir: string, skill: string): Promise<SkillEvalResult | null> {
  const files = await listSkillEvalResults(stateDir, skill);
  const last = files[files.length - 1];
  return last === undefined ? null : readSkillEvalResult(last);
}

function safeName(skill: string): string {
  return skill.replace(/[^A-Za-z0-9._-]/g, "_");
}
