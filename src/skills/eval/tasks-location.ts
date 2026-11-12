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
 * file holds the expected answers. Other skills may ship `evals/tasks.yaml`
 * or a top-level `tasks.yaml` next to their SKILL.md.
 */
export const SKILL_TASKS_FILE_CANDIDATES: readonly string[] = [
  join("evals", "tasks.yaml"),
  join("evals", "tasks.yml"),
  "tasks.yaml",
  "tasks.yml",
];

export interface SkillTasksRoots {
  /** The packaged `starter-skills/` tree (`resolveStarterSkillsSourceDir()`), searched first. */
  starterDir: string | null;
  /** `<stateDir>/skills/`. */
  globalSkillsDir: string;
}

/** The tasks file of `skill`, or null when it has none. */
export function findSkillTasksFile(skill: string, roots: SkillTasksRoots): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) return null;
  for (const root of [roots.starterDir, roots.globalSkillsDir]) {
    if (root === null) continue;
    for (const candidate of SKILL_TASKS_FILE_CANDIDATES) {
      const path = join(root, skill, candidate);
      if (isFile(path)) return path;
    }
  }
  return null;
}

/** Every skill (starter or installed) that has a tasks file, sorted by name. `--all` evaluates these. */
export async function listSkillsWithTasks(roots: SkillTasksRoots): Promise<Array<{ skill: string; tasksFile: string }>> {
  const names = new Set<string>();
  for (const root of [roots.starterDir, roots.globalSkillsDir]) {
    if (root === null) continue;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) if (isFile(join(root, name, "SKILL.md"))) names.add(name);
  }
  const found: Array<{ skill: string; tasksFile: string }> = [];
  for (const skill of [...names].sort()) {
    const tasksFile = findSkillTasksFile(skill, roots);
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
