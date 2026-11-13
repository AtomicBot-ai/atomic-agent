import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where a skill's Skill Lab tasks file is found when `--tasks` is not
 * given (ATO-1163), checked in this order inside each skill folder.
 *
 * Starter skills keep theirs in `starter-skills/<name>/evals/`, which the
 * seeder does NOT copy into `<stateDir>/skills/` (`seed-starter-skills.ts`):
 * the model can read any file under a loaded skill's folder, and a tasks
 * file holds the expected answers.
 */
export const SKILL_TASKS_FILE_CANDIDATES: readonly string[] = [
  join("evals", "tasks.yaml"),
  join("evals", "tasks.yml"),
  "tasks.yaml",
  "tasks.yml",
];

export interface SkillTasksRoots {
  /** The packaged `starter-skills/` tree (`resolveStarterSkillsSourceDir()`): the only tree searched on its own. */
  starterDir: string | null;
  /** `<stateDir>/skills/`: installed skills. Never run without `--tasks`; read only to say so. */
  globalSkillsDir: string;
}

/**
 * The tasks file `skill eval` may run without `--tasks`: only one the
 * agent ships, in the packaged starter tree. A tasks file is code (its
 * `command` checks run in a shell nobody approves), and an installed
 * skill's folder holds whatever its source put there: a ClawHub or tap
 * install, a copied folder. The installer records no origin, so every
 * installed skill is treated alike: it runs only when the person names
 * the file with `--tasks` (see `findInstalledSkillTasksFile`).
 */
export function findSkillTasksFile(skill: string, roots: SkillTasksRoots): string | null {
  return findIn(roots.starterDir, skill);
}

/**
 * A tasks file inside an installed skill's folder, which `skill eval`
 * does not run on its own. For the error that tells the person to look at
 * it and pass it with `--tasks`.
 */
export function findInstalledSkillTasksFile(skill: string, roots: SkillTasksRoots): string | null {
  return findIn(roots.globalSkillsDir, skill);
}

/** Every packaged starter skill that has a tasks file, sorted by name. `--all` evaluates these, nothing else. */
export async function listSkillsWithTasks(roots: SkillTasksRoots): Promise<Array<{ skill: string; tasksFile: string }>> {
  return listIn(roots.starterDir);
}

/** Installed skills that carry a tasks file `--all` leaves out (they need `--tasks`). */
export async function listInstalledSkillsWithTasks(roots: SkillTasksRoots): Promise<Array<{ skill: string; tasksFile: string }>> {
  const starters = new Set((await listIn(roots.starterDir)).map((e) => e.skill));
  return (await listIn(roots.globalSkillsDir)).filter((e) => !starters.has(e.skill));
}

function findIn(root: string | null, skill: string): string | null {
  if (root === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) return null;
  for (const candidate of SKILL_TASKS_FILE_CANDIDATES) {
    const path = join(root, skill, candidate);
    if (isFile(path)) return path;
  }
  return null;
}

async function listIn(root: string | null): Promise<Array<{ skill: string; tasksFile: string }>> {
  if (root === null) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found: Array<{ skill: string; tasksFile: string }> = [];
  for (const skill of entries.sort()) {
    if (!isFile(join(root, skill, "SKILL.md"))) continue;
    const tasksFile = findIn(root, skill);
    if (tasksFile !== null) found.push({ skill, tasksFile });
  }
  return found;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
