import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveStarterSkillsSourceDir } from "../seed-starter-skills.js";
import { loadTaskSet } from "./task-set.js";

// ATO-1163: every packaged starter tasks file loads, names its own skill,
// and every helper script a command check calls is shipped next to it.
describe("starter skill evals", () => {
  const starterDir = resolveStarterSkillsSourceDir();
  const names = starterDir
    ? readdirSync(starterDir).filter((name) => existsSync(join(starterDir, name, "evals", "tasks.yaml")))
    : [];

  it("ships tasks for the offline-checkable starters", () => {
    expect(starterDir).not.toBeNull();
    expect(names).toEqual(
      expect.arrayContaining(["audit", "code-graph", "pandoc", "pdf", "plain-writing", "skill-creator", "verify-work", "xlsx"]),
    );
  });

  it.each(names)("%s: the tasks file loads and its checks' scripts exist", async (name) => {
    const evalsDir = join(starterDir!, name, "evals");
    const set = await loadTaskSet(join(evalsDir, "tasks.yaml"));
    expect(set.skill).toBe(name);
    expect(set.tasks.length).toBeGreaterThan(0);
    for (const task of set.tasks) {
      expect(task.checks.length).toBeGreaterThan(0);
      for (const check of task.checks) {
        if (check.type !== "command") continue;
        for (const match of check.run.matchAll(/\$SKILL_EVAL_TASKS_DIR\/([\w./-]+)/g)) {
          expect(existsSync(join(evalsDir, match[1]!)), `${name}/${task.id}: ${match[1]}`).toBe(true);
        }
      }
    }
  });
});
