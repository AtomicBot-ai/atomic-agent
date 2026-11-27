import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commandRunsShell,
  defaultClaudeCommandsDir,
  listCommandCatalog,
  prepareCommand,
  prepareCommandNow,
} from "./command-catalog.js";
import { CommandShellRefused } from "./command-shell.js";
import type { UserCommandOptions } from "./user-commands.js";

let root: string;
let opts: UserCommandOptions;

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "command-catalog-"));
  opts = { stateDir: join(root, "state"), workingDir: join(root, "work"), projectTrusted: true,
    claudeCommandsDir: join(root, "home", ".claude", "commands") };
  mkdirSync(opts.workingDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("~/.claude/commands as a compatible folder (ATO-2441)", () => {
  it("lists Claude Code's user commands after the profile, and the profile wins a name", () => {
    put(join(opts.claudeCommandsDir!, "standup.md"), "---\ndescription: Daily standup\nmodel: claude-haiku-4\n---\nSummarise\n");
    put(join(opts.claudeCommandsDir!, "commit.md"), "Claude's commit\n");
    put(join(opts.stateDir, "commands", "commit.md"), "Our commit\n");
    const rows = listCommandCatalog(opts).rows;
    expect(rows.map(r => [r.name, r.source])).toEqual([["commit", "profile"], ["standup", "claude"]]);
    expect(rows[1]).toMatchObject({ description: "Daily standup", model: "claude-haiku-4" });
    expect(prepareCommandNow(opts, "standup", "")).toEqual({ text: "Summarise", source: "claude", model: "claude-haiku-4" });
  });

  it("is ~/.claude/commands by default, elsewhere or off by environment", () => {
    expect(defaultClaudeCommandsDir({}, "/home/me")).toBe(join("/home/me", ".claude", "commands"));
    expect(defaultClaudeCommandsDir({ ATOMIC_AGENT_CLAUDE_COMMANDS_DIR: "/x/cmds" }, "/home/me")).toBe("/x/cmds");
    expect(defaultClaudeCommandsDir({ ATOMIC_AGENT_CLAUDE_COMMANDS_DIR: "" }, "/home/me")).toBeUndefined();
  });
});

describe("hidden project commands", () => {
  it("counts the command files of a folder that is not trusted, and none once it is", () => {
    put(join(opts.workingDir, ".atomic-agent", "commands", "deploy.md"), "Deploy\n");
    put(join(opts.workingDir, ".claude", "commands", "team", "review.md"), "Review\n");
    const untrusted = listCommandCatalog({ ...opts, projectTrusted: false });
    expect(untrusted.rows).toEqual([]);
    expect(untrusted.hiddenProjectCommands).toBe(2);
    expect(listCommandCatalog(opts).hiddenProjectCommands).toBe(0);
  });
});

describe("prepareCommand with shell lines", () => {
  it("marks the command, inlines mentions first, then runs each line through the runner", async () => {
    put(join(opts.stateDir, "commands", "review.md"), "Review @notes.md against:\n!`git diff $1`\n");
    expect(listCommandCatalog(opts).rows[0]).toMatchObject({ name: "review", runsShell: true });
    expect(commandRunsShell(opts, "REVIEW")).toBe(true);
    expect(() => prepareCommandNow(opts, "review", "")).toThrow("needs the approval path");
    const runShell = vi.fn(async () => "@not-a-file printed by git");
    const expandMentions = vi.fn((text: string) => `${text}\n[mentions expanded]`);
    const prepared = await prepareCommand(opts, "review", "main", { runShell, expandMentions });
    expect(runShell).toHaveBeenCalledWith("git diff main");
    expect(expandMentions.mock.calls[0]![0]).not.toContain("printed by git");
    expect(prepared.text).toBe("Review @notes.md against:\n@not-a-file printed by git\n[mentions expanded]");
  });

  it("sends nothing when a line is refused", async () => {
    put(join(opts.stateDir, "commands", "push.md"), "!`git push`\nDone?\n");
    const runShell = vi.fn(async (command: string) => { throw new CommandShellRefused(command, "was not allowed"); });
    await expect(prepareCommand(opts, "push", "", { runShell })).rejects.toThrow("`git push` was not allowed");
  });

  it("does not turn arguments into shell lines", async () => {
    put(join(opts.stateDir, "commands", "echo.md"), "Say $ARGUMENTS\n");
    const runShell = vi.fn(async () => "x");
    expect(commandRunsShell(opts, "echo")).toBe(false);
    const prepared = await prepareCommand(opts, "echo", "!`rm -rf ~`", { runShell });
    expect(prepared.text).toBe("Say !`rm -rf ~`");
    expect(runShell).not.toHaveBeenCalled();
  });

  it("still renders a plugin-style name it does not know as an error, not a shell run", () => {
    expect(() => prepareCommandNow(opts, "missing", "")).toThrow("command /missing is not available");
  });
});
