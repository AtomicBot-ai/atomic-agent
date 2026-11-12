import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSkillTasksFile, listSkillsWithTasks } from "./tasks-location.js";

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

  it("prefers the packaged starter tree, then the installed skill folder", () => {
    const roots = { starterDir, globalSkillsDir };
    expect(findSkillTasksFile("pdf", roots)).toBe(join(starterDir, "pdf", "evals", "tasks.yaml"));
    expect(findSkillTasksFile("mine", roots)).toBe(join(globalSkillsDir, "mine", "tasks.yaml"));
    expect(findSkillTasksFile("third", roots)).toBe(join(globalSkillsDir, "third", "evals", "tasks.yml"));
    expect(findSkillTasksFile("plain", roots)).toBeNull();
    expect(findSkillTasksFile("missing", roots)).toBeNull();
  });

  it("never looks outside a skill folder", () => {
    expect(findSkillTasksFile("../pdf", { starterDir, globalSkillsDir })).toBeNull();
    expect(findSkillTasksFile("acme:review", { starterDir, globalSkillsDir })).toBeNull();
  });

  it("lists every skill with a tasks file once, sorted", async () => {
    expect((await listSkillsWithTasks({ starterDir, globalSkillsDir })).map((e) => e.skill)).toEqual(["mine", "pdf", "third"]);
    expect(await listSkillsWithTasks({ starterDir: null, globalSkillsDir: join(dir, "nope") })).toEqual([]);
  });
});
