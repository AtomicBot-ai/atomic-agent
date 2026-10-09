import { describe, expect, it, vi } from "vitest";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { skillSlashCommands, resolveSlashCommand, filterSlashCommands } from "../commands/slash-commands.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { reduceTuiState as tuiReducer } from "../agent-event-reducer.js";
import type { SkillSummaryRow } from "./skills-panel-state.js";

function state() {
  const s = createInitialTuiState(fakeSession());
  const row = (name: string, disabled = false): SkillSummaryRow => ({ name, disabled, description: name, source: "project", version: "1" });
  s.skillsPanel = { ...s.skillsPanel, workspace: "/work", rows: [row("openspec-explore"), row("other-skill"), row("disabled-skill", true), row("help"), row("exit")] };
  return s;
}

describe("cloud skill slash submission", () => {
  it("shares enabled commands across filtering, resolution and keyboard/mouse cursor bounds", () => {
    let s = state();
    const commands = skillSlashCommands(s.skillsPanel);
    expect(commands.map(c => c.name)).toEqual(["openspec-explore", "other-skill"]);
    expect(resolveSlashCommand("exit", commands)?.name).toBe("quit");
    expect(resolveSlashCommand("disabled-skill", commands)).toBeNull();
    s = tuiReducer(s, { type: "slash_palette_opened", query: "skill" });
    for (let i = 0; i < 100; i++) s = tuiReducer(s, { type: "slash_palette_cursor_moved", delta: 1 });
    expect(s.slashPaletteCursor).toBe(filterSlashCommands("skill", commands).length - 1);
    s = tuiReducer(s, { type: "slash_palette_cursor_set", row: 100 });
    expect(s.slashPaletteCursor).toBe(filterSlashCommands("skill", commands).length - 1);
    expect(skillSlashCommands({ ...s.skillsPanel, workspace: undefined })).toEqual([]);
  });

  it.each(["steer", "queue"] as const)("uses the normal %s path while busy", mode => {
    const s = state(); s.status = "running"; s.whileBusyMode = mode;
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {},
      onMessageSubmitted: vi.fn(), onMessageSteered: vi.fn(),
      prepareSkillInvocation: vi.fn(() => "validated skill request") };
    handleEditorSubmit("/openspec-explore investigate this", s, vi.fn(), callbacks);
    expect(callbacks.prepareSkillInvocation).toHaveBeenCalledWith("openspec-explore", "investigate this");
    expect(mode === "steer" ? callbacks.onMessageSteered : callbacks.onMessageSubmitted).toHaveBeenCalledWith("validated skill request");
  });

  it("clears a foreign workspace catalog when the new scan fails", () => {
    const s = tuiReducer(state(), { type: "skills_refresh_failed", error: "Unreadable instructions" });
    expect(skillSlashCommands(s.skillsPanel)).toEqual([]);
    expect(s.skillsPanel.rows).toEqual([]);
  });
});
