import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pluginSlashCommands, resolveSlashCommand } from "../commands/slash-commands.js";
import { dispatchSlashCommand } from "../commands/slash-command-handler.js";
import { MENTION_BLOCK_OPEN } from "../../mentions/mention-block.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { SkillsOrchestrator } from "./skills-orchestrator.js";
import type { PluginCommandRow } from "./skills-panel-state.js";

const own = (name: string, source: "project" | "profile", description = name): PluginCommandRow =>
  ({ name, command: name, description, source });
const plugin = (name: string): PluginCommandRow => ({ name, command: name.slice(name.indexOf(":") + 1), description: name });

describe("the operator's own commands in the slash palette (ATO-2229)", () => {
  it("lists them by name with their folder, and keeps the bare name from a plugin", () => {
    const commands = pluginSlashCommands([own("review", "project", "Review the diff"), plugin("tools:review")]);
    expect(commands).toEqual([
      { name: "review", description: "Review the diff (project)", pluginCommand: "review" },
      { name: "tools:review", description: "tools:review", pluginCommand: "tools:review" },
    ]);
    expect(dispatchSlashCommand("/review src/a.ts", commands).pluginCommandInvocation)
      .toEqual({ name: "review", args: "src/a.ts" });
  });

  it("shows only the first row of a name: project, then profile, then plugin", () => {
    const commands = pluginSlashCommands([own("team:review", "project"), own("team:review", "profile"), plugin("team:review")]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.description).toBe("team:review (project)");
  });

  it("never shadows a built-in command", () => {
    const commands = pluginSlashCommands([own("help", "profile")]);
    expect(commands).toEqual([]);
    expect(resolveSlashCommand("help", commands)?.pluginCommand).toBeUndefined();
  });
});

describe("SkillsOrchestrator.preparePluginCommand for own commands", () => {
  let root: string;
  let stateDir: string;
  let workingDir: string;
  let orchestrator: SkillsOrchestrator;

  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "own-commands-"));
    stateDir = join(root, "state");
    workingDir = join(root, "work");
    mkdirSync(workingDir, { recursive: true });
    const runtime = {
      config: { paths: { stateDir, userConfigFile: join(stateDir, "config.json") }, skills: { projectTrust: [] } },
      capabilities: { workingDir },
    } as unknown as AgentRuntime;
    orchestrator = new SkillsOrchestrator(runtime, { subscribe: () => () => {}, emit: () => {} });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("renders a profile command and inlines the files it names from the working folder", () => {
    put(join(stateDir, "commands", "review.md"), "Review $1 against @{docs/rules.md}\n");
    put(join(workingDir, "docs", "rules.md"), "No globals.\n");
    put(join(workingDir, "src", "a.ts"), "export const a = 1;\n");
    const text = orchestrator.preparePluginCommand("review", "@src/a.ts");
    expect(text.startsWith("Review @src/a.ts against @docs/rules.md")).toBe(true);
    expect(text).toContain(MENTION_BLOCK_OPEN);
    expect(text).toContain("No globals.");
    expect(text).toContain("export const a = 1;");
  });

  it("does not run a project command in a folder that is not trusted", () => {
    put(join(workingDir, ".atomic-agent", "commands", "deploy.md"), "Deploy\n");
    expect(() => orchestrator.preparePluginCommand("deploy", "")).toThrow("command /deploy is not available");
  });
});
