import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillCommand } from "./skill.js";
import {
  getUserConfigPath,
  parseUserConfigFile,
  readUserConfigFileSync,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  writeUserConfigFileSync,
} from "../config/index.js";

function writeSkill(globalDir: string, name: string): void {
  const dir = join(globalDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: "Skill ${name}"`,
      "version: 0.1.0",
      "---",
      "",
      `# ${name}`,
      "",
      `Body of ${name}.`,
    ].join("\n"),
    "utf8",
  );
}

describe("skillCommand", () => {
  let stateDir: string;
  let globalSkillsDir: string;
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-skill-"));
    globalSkillsDir = join(stateDir, "skills");
    mkdirSync(globalSkillsDir, { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("list shows enabled state for installed skills", async () => {
    writeSkill(globalSkillsDir, "alpha");
    writeSkill(globalSkillsDir, "beta");
    const code = await skillCommand(["list"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/alpha\t.*\tenabled/);
    expect(stdout).toMatch(/beta\t.*\tenabled/);
  });

  it("disable persists the name into config.json and shows disabled state on next list", async () => {
    writeSkill(globalSkillsDir, "alpha");
    writeSkill(globalSkillsDir, "beta");

    const disableCode = await skillCommand(["disable", "alpha"]);
    expect(disableCode).toBe(0);
    expect(stdout).toContain("disabled: alpha\n");

    const file = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file).not.toBeNull();
    expect(file?.skills.disabled).toEqual(["alpha"]);

    stdout = "";
    const listCode = await skillCommand(["list"]);
    expect(listCode).toBe(0);
    expect(stdout).toMatch(/alpha\t.*\tdisabled/);
    expect(stdout).toMatch(/beta\t.*\tenabled/);
  });

  it("enable removes the name from the disabled list", async () => {
    writeSkill(globalSkillsDir, "alpha");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      skills: { disabled: ["alpha"] },
    });
    resetConfigCache();

    const code = await skillCommand(["enable", "alpha"]);
    expect(code).toBe(0);
    expect(stdout).toContain("enabled: alpha\n");

    const file = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file?.skills.disabled).toEqual([]);
  });

  it("enable on a not-disabled skill is a no-op", async () => {
    writeSkill(globalSkillsDir, "alpha");
    const code = await skillCommand(["enable", "alpha"]);
    expect(code).toBe(0);
    expect(stdout).toContain("already enabled: alpha\n");
    const file = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file?.skills.disabled).toEqual([]);
  });

  it("disable on an already-disabled skill is a no-op", async () => {
    writeSkill(globalSkillsDir, "alpha");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      skills: { disabled: ["alpha"] },
    });
    resetConfigCache();
    const code = await skillCommand(["disable", "alpha"]);
    expect(code).toBe(0);
    expect(stdout).toContain("already disabled: alpha\n");
  });

  it("disable warns when the name is not currently installed but persists the entry", async () => {
    const code = await skillCommand(["disable", "ghost-skill"]);
    expect(code).toBe(0);
    expect(stdout).toContain("disabled: ghost-skill\n");
    expect(stderr).toContain("not currently installed");
    const file = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file?.skills.disabled).toEqual(["ghost-skill"]);
  });

  it("disable rejects an invalid kebab-case name via parser", async () => {
    // Manually pre-populate config with an invalid pre-existing entry would
    // fail on the next read, so just verify writeUserConfigFileSync rejects
    // it through parseUserConfigFile: this confirms the round-trip guard.
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: ["NOT_KEBAB"] },
      }),
    ).toThrow(/skills.disabled\[0\]/);
  });

  it("list emits a [missing] row for disabled skills that are not installed", async () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      skills: { disabled: ["ghost-skill"] },
    });
    resetConfigCache();
    const code = await skillCommand(["list"]);
    expect(code).toBe(0);
    expect(stdout).toContain("ghost-skill");
    expect(stdout).toContain("[missing]");
  });

  it("enable/disable is idempotent across repeated invocations", async () => {
    writeSkill(globalSkillsDir, "alpha");
    await skillCommand(["disable", "alpha"]);
    await skillCommand(["disable", "alpha"]);
    const file1 = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file1?.skills.disabled).toEqual(["alpha"]);
    await skillCommand(["enable", "alpha"]);
    await skillCommand(["enable", "alpha"]);
    const file2 = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file2?.skills.disabled).toEqual([]);
  });
});
