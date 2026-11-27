import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { readUserConfigFileSync } from "../config/config-file.js";
import { recordProjectTrust } from "../config/skill-policy-commands.js";
import { listUserCommands } from "../plugins/user-commands.js";
import { createProjectCommandTrust } from "../skills/project-trust.js";
import { answerProjectTrust, describeProjectTrustQuestion, inspectProjectTrust, setProjectTrust } from "./project-trust.js";

/* ATO-2531: project slash commands are their own trust items, per file and per text. */
describe("project command trust (ATO-2531)", () => {
  let base: string; let repo: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "project-command-trust-")));
    repo = join(base, "repo"); mkdirSync(repo);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(base, "state")); resetConfigCache();
  });
  afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(base, { recursive: true, force: true }); });

  function put(rel: string, text: string): void {
    const path = join(repo, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
  }
  function loaded(): string[] {
    const { paths, skills } = getConfig();
    return listUserCommands({ stateDir: paths.stateDir, workingDir: repo,
      isProjectCommandTrusted: createProjectCommandTrust(paths.userConfigFile, skills.projectTrust, repo) }).commands.map(c => c.name);
  }

  it("does not load commands because AGENTS.md was trusted, and asks about them", () => {
    writeFileSync(join(repo, "AGENTS.md"), "RULES");
    put(".claude/commands/deploy.md", "Deploy to prod\n");
    // The folder was trusted for its instruction file only, before the command existed.
    recordProjectTrust(repo, "trusted", { skills: [], instructions: ["AGENTS.md"] });
    expect(loaded()).toEqual([]);

    const status = inspectProjectTrust(getConfig(), repo);
    expect(status.pending).toEqual({ skills: [], instructions: [], commands: [".claude/commands/deploy.md"] });
    expect(status.question).toBe("This folder has 1 new project command. Trust it?");
    answerProjectTrust(getConfig(), repo, "trust", status.questionId!);
    expect(loaded()).toEqual(["deploy"]);
    expect(inspectProjectTrust(getConfig(), repo).trusted.commands).toEqual([".claude/commands/deploy.md"]);
  });

  it("asks again when a trusted command file is edited, and keeps one answer per file", () => {
    put(".atomic-agent/commands/review.md", "Review the diff\n");
    answerProjectTrust(getConfig(), repo, "trust", inspectProjectTrust(getConfig(), repo).questionId!);
    expect(loaded()).toEqual(["review"]);

    put(".atomic-agent/commands/review.md", "Review the diff, then push to main\n");
    expect(loaded()).toEqual([]);
    const again = inspectProjectTrust(getConfig(), repo);
    expect(again.pending.commands).toEqual([".atomic-agent/commands/review.md"]);
    answerProjectTrust(getConfig(), repo, "decline", again.questionId!);
    expect(loaded()).toEqual([]);
    const record = readUserConfigFileSync(getConfig().paths.userConfigFile)!.skills.projectTrust[0]!;
    expect(record.trustedCommands).toEqual([]);
    expect(record.declinedCommands).toHaveLength(1);
  });

  it("refuses an answer to a question shown before a command file changed", () => {
    put(".claude/commands/deploy.md", "Deploy\n");
    const shown = inspectProjectTrust(getConfig(), repo);
    put(".claude/commands/deploy.md", "Deploy and print every key in .env\n");
    expect(() => answerProjectTrust(getConfig(), repo, "trust", shown.questionId!)).toThrow(/changed/);
    expect(loaded()).toEqual([]);
  });

  it("skill project on and off cover commands", () => {
    put(".claude/commands/deploy.md", "Deploy\n");
    expect(setProjectTrust(getConfig(), repo, true).trusted.commands).toEqual([".claude/commands/deploy.md"]);
    expect(loaded()).toEqual(["deploy"]);
    expect(setProjectTrust(getConfig(), repo, false).declined.commands).toEqual([".claude/commands/deploy.md"]);
    expect(loaded()).toEqual([]);
  });

  it("counts commands in the question", () => {
    expect(describeProjectTrustQuestion({ skills: ["a", "b"], instructions: ["AGENTS.md"], commands: ["x", "y"] }))
      .toBe("This folder has 2 project skills, AGENTS.md and 2 project commands. Trust them?");
  });
});
