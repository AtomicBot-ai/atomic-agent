import { describe, expect, it, vi } from "vitest";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import {
  filterSlashCommands,
  pluginSlashCommands,
  resolveSlashCommand,
  skillSlashCommands,
  SLASH_COMMANDS,
} from "../commands/slash-commands.js";
import { dispatchSlashCommand } from "../commands/slash-command-handler.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { reduceTuiState as tuiReducer } from "../agent-event-reducer.js";
import type { PluginCommandRow, SkillSummaryRow } from "./skills-panel-state.js";

const plugin = (name: string, description = name, argumentHint?: string): PluginCommandRow => ({
  name,
  command: name.slice(name.indexOf(":") + 1),
  description,
  ...(argumentHint ? { argumentHint } : {}),
});

function state(commands: readonly PluginCommandRow[]) {
  return tuiReducer(createInitialTuiState(fakeSession()), { type: "skills_plugin_commands_set", commands });
}

describe("plugin commands in the slash palette", () => {
  it("lists plugin commands in local mode with the bare alias when it is free", () => {
    const s = state([plugin("tools:review", "Review code", "<file>"), plugin("tools:commit")]);
    const commands = skillSlashCommands(s.skillsPanel);
    expect(commands).toEqual([
      { name: "tools:review", description: "Review code <file>", aliases: ["review"], pluginCommand: "tools:review" },
      { name: "tools:commit", description: "tools:commit", aliases: ["commit"], pluginCommand: "tools:commit" },
    ]);
    expect(resolveSlashCommand("review", commands)?.pluginCommand).toBe("tools:review");
    expect(filterSlashCommands("review", commands).map(c => c.name)).toContain("tools:review");
  });

  it("never lets a plugin command shadow a built-in, a skill or another plugin's command", () => {
    const builtin = SLASH_COMMANDS[0]!.name;
    const skillRow: SkillSummaryRow = { name: "deploy", description: "skill", source: "project", version: "1", disabled: false };
    const skills = [{ name: "deploy", description: "skill", skillName: "deploy" }];
    const commands = pluginSlashCommands([
      plugin(`a:${builtin}`),
      plugin("a:deploy"),
      plugin("a:lint"),
      plugin("b:lint"),
    ], skills);
    expect(commands.map(c => [c.name, c.aliases ?? []])).toEqual([
      [`a:${builtin}`, []],
      ["a:deploy", []],
      ["a:lint", []],
      ["b:lint", []],
    ]);
    expect(resolveSlashCommand(builtin, commands)?.pluginCommand).toBeUndefined();

    const s = createInitialTuiState(fakeSession());
    s.skillsPanel = { ...s.skillsPanel, workspace: "/work", rows: [skillRow], pluginCommands: [plugin("a:deploy")] };
    expect(resolveSlashCommand("deploy", skillSlashCommands(s.skillsPanel))?.skillName).toBe("deploy");
  });

  it("dispatches a plugin command with its raw arguments", () => {
    const commands = pluginSlashCommands([plugin("tools:review")]);
    expect(dispatchSlashCommand(`/review src/a.ts "only tests"`, commands).pluginCommandInvocation)
      .toEqual({ name: "tools:review", args: `src/a.ts "only tests"` });
    expect(dispatchSlashCommand("/tools:review", commands).pluginCommandInvocation)
      .toEqual({ name: "tools:review", args: "" });
  });

  it("sends the rendered template as the user's message", () => {
    const s = state([plugin("tools:review")]);
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {},
      onMessageSubmitted: vi.fn(), preparePluginCommand: vi.fn(() => "Review src/a.ts") };
    handleEditorSubmit("/review src/a.ts", s, vi.fn(), callbacks);
    expect(callbacks.preparePluginCommand).toHaveBeenCalledWith("tools:review", "src/a.ts");
    expect(callbacks.onMessageSubmitted).toHaveBeenCalledWith("Review src/a.ts");
  });

  it("reports a command that can no longer run instead of sending it", () => {
    const s = state([plugin("tools:review")]);
    const dispatch = vi.fn();
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {},
      onMessageSubmitted: vi.fn(), onSkillsRefreshRequested: vi.fn(),
      preparePluginCommand: vi.fn(() => { throw new Error("plugin command /tools:review is turned off"); }) };
    handleEditorSubmit("/tools:review", s, dispatch, callbacks);
    expect(callbacks.onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "system_message", text: "plugin command /tools:review is turned off" });
    expect(callbacks.onSkillsRefreshRequested).toHaveBeenCalled();
  });

  it("keeps plugin commands when a skill scan fails", () => {
    const s = tuiReducer(state([plugin("tools:review")]), { type: "skills_refresh_failed", error: "boom" });
    expect(skillSlashCommands(s.skillsPanel).map(c => c.name)).toEqual(["tools:review"]);
  });
});
