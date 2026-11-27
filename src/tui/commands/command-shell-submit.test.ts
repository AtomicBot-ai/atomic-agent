import { describe, expect, it, vi } from "vitest";
import { reduceTuiState } from "../agent-event-reducer.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { apply, fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiAction } from "../tui-action.js";
import type { PluginCommandRow } from "../skills/skills-panel-state.js";
import { NEW_CHAT_COMMAND_SESSION_ID } from "./command-shell-session.js";

const review: PluginCommandRow = { name: "review", command: "review", description: "Review", source: "profile" };

function idleState() {
  return reduceTuiState(createInitialTuiState(fakeSession()), { type: "skills_plugin_commands_set", commands: [review] });
}

function request(id: string, sessionId: string) {
  return { approvalId: id, sessionId, tool: "os.shell.run", category: "shell" as const, reason: "r" };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("an own command with shell lines in the terminal (ATO-2441)", () => {
  it("asks in the chat on screen, then sends the message once the lines ran", async () => {
    const dispatched: TuiAction[] = [];
    let finish!: (text: string) => void;
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {}, onMessageSubmitted: vi.fn(),
      preparePluginCommand: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })) };
    handleEditorSubmit("/review main", idleState(), a => dispatched.push(a), callbacks);
    // A new chat has no session yet: its shell lines ask under the new-chat owner.
    expect(callbacks.preparePluginCommand).toHaveBeenCalledWith("review", "main", NEW_CHAT_COMMAND_SESSION_ID);
    expect(dispatched.map(a => a.type)).toContain("message_submitted");
    expect(callbacks.onMessageSubmitted).not.toHaveBeenCalled();
    finish("Review:\n+diff");
    await flush();
    expect(callbacks.onMessageSubmitted).toHaveBeenCalledWith("Review:\n+diff");
  });

  it("sends nothing and hands the composer back when a line is refused", async () => {
    const dispatched: TuiAction[] = [];
    const callbacks = { onApprovalDecision() {}, onAbort() {}, onQuit() {}, onMessageSubmitted: vi.fn(),
      onSkillsRefreshRequested: vi.fn(),
      preparePluginCommand: vi.fn(() => Promise.reject(new Error("`git push` was not allowed"))) };
    handleEditorSubmit("/review", idleState(), a => dispatched.push(a), callbacks);
    await flush();
    expect(callbacks.onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatched.at(-1)).toEqual({ type: "command_not_sent", text: "/review was not sent: `git push` was not allowed", resetRun: true });
    const after = apply(idleState(), dispatched);
    expect(after.status).toBe("idle");
    expect(after.messages.at(-1)?.text).toContain("was not allowed");
  });

  it("opens the approval modal for the new chat's request and resumes after the answer", () => {
    const running = apply(idleState(), [{ type: "message_submitted" }]);
    const asked = reduceTuiState(running, { type: "approval_requested", request: request("a1", NEW_CHAT_COMMAND_SESSION_ID) });
    expect(asked.pendingApproval?.approvalId).toBe("a1");
    expect(asked.status).toBe("awaiting_approval");
    expect(reduceTuiState(asked, { type: "approval_resolved", approvalId: "a1", approved: true }).status).toBe("running");
  });

  it("keeps a running turn's status when a line refused while it ran", () => {
    const running = apply(idleState(), [{ type: "message_submitted" }]);
    const next = reduceTuiState(running, { type: "command_not_sent", text: "x", resetRun: false });
    expect(next.status).toBe("running");
  });
});
