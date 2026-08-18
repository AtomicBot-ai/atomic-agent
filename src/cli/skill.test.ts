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

// Only `browseHub`/`searchHub` are stubbed; everything else in the hub
// module (identifier parsing, installer, scan summary) stays real so the
// install and tap tests below are unaffected.
vi.mock("../skills/hub/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/hub/index.js")>()),
  browseHub: vi.fn(async () => ({
    entries: [],
    errors: [{ repo: "owner/repo", error: "boom" }],
  })),
  searchHub: vi.fn(async () => ({
    entries: [],
    errors: [{ repo: "owner/repo", error: "boom" }],
  })),
}));

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

  it("uninstall removes the global skill dir and prunes the disabled entry", async () => {
    writeSkill(globalSkillsDir, "alpha");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      skills: { disabled: ["alpha", "beta"] },
    });
    resetConfigCache();

    const code = await skillCommand(["uninstall", "alpha"]);
    expect(code).toBe(0);
    expect(stdout).toContain("removed ");

    // Directory is gone and the stale disable entry is dropped (beta stays).
    const listCode = await skillCommand(["list"]);
    expect(listCode).toBe(0);
    const file = readUserConfigFileSync(getUserConfigPath(stateDir));
    expect(file?.skills.disabled).toEqual(["beta"]);
  });

  it("uninstall on a skill not installed globally returns 1", async () => {
    const code = await skillCommand(["uninstall", "ghost-skill"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not installed globally: ghost-skill");
  });

  it("show on a skill that is not installed returns 1", async () => {
    writeSkill(globalSkillsDir, "alpha");
    const code = await skillCommand(["show", "ghost-skill"]);
    expect(code).toBe(1);
    expect(stderr).toContain("skill not installed: ghost-skill");
  });

  it("install over an existing skill returns 1", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "atomic-cli-skill-src-"));
    try {
      writeSkill(sourceDir, "alpha");
      expect(await skillCommand(["install", join(sourceDir, "alpha")])).toBe(0);
      const code = await skillCommand(["install", join(sourceDir, "alpha")]);
      expect(code).toBe(1);
      expect(stderr).toContain("already installed");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("returns 2 for a missing required argument", async () => {
    expect(await skillCommand(["show"])).toBe(2);
    expect(await skillCommand(["uninstall"])).toBe(2);
    expect(await skillCommand(["enable"])).toBe(2);
    expect(await skillCommand(["disable"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill show <name>");
    expect(stderr).toContain("usage: atomic-agent skill uninstall <name>");
  });

  it("returns 2 for an unknown subcommand", async () => {
    const code = await skillCommand(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown subcommand: frobnicate");
  });

  it("returns 2 for a tap repo argument of the wrong shape", async () => {
    const code = await skillCommand(["tap", "add", "not-a-repo"]);
    expect(code).toBe(2);
    expect(stderr).toContain("not-a-repo");
  });

  it("returns 2 for the remaining argument-shape errors", async () => {
    // The rest of the usage surface, which reaches its branch without any
    // network: install with no source, browse with a valueless --source,
    // search with an empty query, tap with a missing repo or a verb that
    // does not exist.
    expect(await skillCommand(["install"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill install");

    expect(await skillCommand(["browse", "--source"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill browse");

    expect(await skillCommand(["search"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill search");

    expect(await skillCommand(["tap", "add"])).toBe(2);
    expect(await skillCommand(["tap", "remove"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill tap add <owner/repo>");

    expect(await skillCommand(["tap", "frobnicate"])).toBe(2);
    expect(stderr).toContain("usage: atomic-agent skill tap list");
  });

  it("browse and search return 1 when every source failed and nothing was found", async () => {
    // ClawHub off so the GitHub tap is the only source; it errors, so the
    // command found nothing and every source it had failed.
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      skills: {
        taps: ["owner/repo"],
        clawhub: { ...USER_CONFIG_DEFAULTS.skills.clawhub, enabled: false },
      },
    });
    resetConfigCache();

    expect(await skillCommand(["browse"])).toBe(1);
    expect(await skillCommand(["search", "anything"])).toBe(1);
    expect(stderr).toContain("WARN: owner/repo: boom");
    expect(stdout).toContain("(no skills found)");
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
