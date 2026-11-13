import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findInstalledSkillTasksFile, findSkillTasksFile, listInstalledSkillsWithTasks, listSkillsWithTasks } from "./tasks-location.js";

function skillDir(root: string, name: string, tasks?: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\nversion: 1.0.0\n---\n`);
  if (tasks) {
    mkdirSync(join(root, name, tasks, ".."), { recursive: true });
    writeFileSync(join(root, name, tasks), "tasks: []\n");
  }
}

describe("tasks file location", () => {
  let dir: string;
  let starterDir: string;
  let globalSkillsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-eval-location-"));
    starterDir = join(dir, "starter");
    globalSkillsDir = join(dir, "skills");
    skillDir(starterDir, "pdf", join("evals", "tasks.yaml"));
    // The seeded copy has no evals/ (the seeder leaves it out).
    skillDir(globalSkillsDir, "pdf");
    skillDir(globalSkillsDir, "mine", "tasks.yaml");
    skillDir(globalSkillsDir, "third", join("evals", "tasks.yml"));
    skillDir(globalSkillsDir, "plain");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds tasks on its own only in the packaged starter tree", () => {
    const roots = { starterDir, globalSkillsDir };
    expect(findSkillTasksFile("pdf", roots)).toBe(join(starterDir, "pdf", "evals", "tasks.yaml"));
    expect(findSkillTasksFile("plain", roots)).toBeNull();
    expect(findSkillTasksFile("missing", roots)).toBeNull();
    expect(findSkillTasksFile("pdf", { starterDir: null, globalSkillsDir })).toBeNull();
  });

  it("leaves a hub-installed skill's tasks out: they run only with --tasks", async () => {
    // What `skill install <clawhub or tap skill>` leaves under the global
    // skills dir: a folder with SKILL.md and, here, a tasks file whose
    // command checks would run in an unapproved shell.
    const roots = { starterDir, globalSkillsDir };
    expect(findSkillTasksFile("mine", roots)).toBeNull();
    expect(findSkillTasksFile("third", roots)).toBeNull();
    expect((await listSkillsWithTasks(roots)).map((e) => e.skill)).toEqual(["pdf"]);
    expect(findInstalledSkillTasksFile("mine", roots)).toBe(join(globalSkillsDir, "mine", "tasks.yaml"));
    expect(findInstalledSkillTasksFile("third", roots)).toBe(join(globalSkillsDir, "third", "evals", "tasks.yml"));
    expect((await listInstalledSkillsWithTasks(roots)).map((e) => e.skill)).toEqual(["mine", "third"]);
  });

  it("never looks outside a skill folder", () => {
    expect(findSkillTasksFile("../pdf", { starterDir, globalSkillsDir })).toBeNull();
    expect(findSkillTasksFile("acme:review", { starterDir, globalSkillsDir })).toBeNull();
    expect(findInstalledSkillTasksFile("../mine", { starterDir, globalSkillsDir })).toBeNull();
  });

  it("lists nothing without a starter tree", async () => {
    expect(await listSkillsWithTasks({ starterDir: null, globalSkillsDir })).toEqual([]);
    expect(await listSkillsWithTasks({ starterDir: join(dir, "nope"), globalSkillsDir })).toEqual([]);
  });
});
