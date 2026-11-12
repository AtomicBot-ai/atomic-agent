import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillCommand } from "./skill.js";
import { resetConfigCache } from "../config/index.js";
import { DAY_MS, readSkillChanges, SkillUsageLedger, skillCuratorPaths } from "../skills/curator/index.js";

function writeSkill(globalDir: string, name: string, body = `Body of ${name}.`): void {
  const dir = join(globalDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: "Skill ${name}"`, "version: 0.1.0", "---", "", body].join("\n"),
    "utf8",
  );
}

describe("skill history / restore / curate", () => {
  let stateDir: string;
  let globalSkillsDir: string;
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-skill-history-"));
    globalSkillsDir = join(stateDir, "skills");
    mkdirSync(globalSkillsDir, { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("uninstall saves a version that restore puts back", async () => {
    writeSkill(globalSkillsDir, "alpha", "original body");
    expect(await skillCommand(["uninstall", "alpha"])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "alpha"))).toBe(false);

    stdout = "";
    expect(await skillCommand(["history", "alpha"])).toBe(0);
    expect(stdout).toMatch(/alpha\tdelete\tuser/);
    expect(stdout).toMatch(/versions: \d{8}T\d{9}Z/);

    expect(await skillCommand(["restore", "alpha"])).toBe(0);
    expect(readFileSync(join(globalSkillsDir, "alpha", "SKILL.md"), "utf8")).toContain("original body");
    const log = await readSkillChanges(skillCuratorPaths(stateDir).changeLog, "alpha");
    expect(log.map((e) => [e.action, e.actor])).toEqual([
      ["delete", "user"],
      ["restore", "user"],
    ]);
  });

  it("restore --version picks a named version", async () => {
    writeSkill(globalSkillsDir, "beta", "first");
    await skillCommand(["uninstall", "beta"]);
    const [version] = (await readSkillChanges(skillCuratorPaths(stateDir).changeLog, "beta")).map((e) => e.snapshot);
    writeSkill(globalSkillsDir, "beta", "second");
    expect(await skillCommand(["restore", "beta", "--version", version!])).toBe(0);
    expect(readFileSync(join(globalSkillsDir, "beta", "SKILL.md"), "utf8")).toContain("first");
  });

  it("restore with nothing saved fails with a clear message", async () => {
    expect(await skillCommand(["restore", "ghost"])).toBe(1);
    expect(stderr).toContain("no saved versions of skill: ghost");
    expect(await skillCommand(["restore"])).toBe(2);
  });

  it("curate archives only agent-learned skills, and restore undoes it", async () => {
    writeSkill(globalSkillsDir, "learned-old");
    writeSkill(globalSkillsDir, "my-own");
    await new SkillUsageLedger(skillCuratorPaths(stateDir).usageFile).markAgentCreated("learned-old", Date.now() - 40 * DAY_MS);

    stdout = "";
    expect(await skillCommand(["curate", "--dry-run"])).toBe(0);
    expect(stdout).toMatch(/would archive\tlearned-old/);
    expect(existsSync(join(globalSkillsDir, "learned-old"))).toBe(true);

    expect(await skillCommand(["curate"])).toBe(0);
    expect(existsSync(join(globalSkillsDir, "learned-old"))).toBe(false);
    expect(existsSync(join(globalSkillsDir, "my-own"))).toBe(true);
    expect(existsSync(join(skillCuratorPaths(stateDir).archiveDir, "learned-old", "SKILL.md"))).toBe(true);

    expect(await skillCommand(["restore", "learned-old"])).toBe(0);
    expect(stdout).toContain("restored learned-old from archive");
    expect(existsSync(join(globalSkillsDir, "learned-old", "SKILL.md"))).toBe(true);
  });
});
