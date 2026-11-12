import { describe, expect, it, vi } from "vitest";

import { NOTHING_TO_RESUME } from "./interrupted-turn-notice.js";
import { dispatchSlashCommand } from "./commands/slash-command-handler.js";
import { resolveSlashCommand } from "./commands/slash-commands.js";
import { handleEditorSubmit } from "./submit-handler.js";
import type { TuiAppCallbacks } from "./tui-app.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";

/** `/resume`: continue a reply a restart cut off, once (ATO-448). */

function idleState(sessionId: string | null = "s1"): TuiState {
  return createInitialTuiState({
    sessionId,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
  });
}

function callbacks(overrides: Partial<TuiAppCallbacks> = {}): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

function systemTexts(dispatched: Array<{ type: string; text?: string }>): string[] {
  return dispatched.flatMap((a) =>
    a.type === "system_message" && a.text !== undefined ? [a.text] : [],
  );
}

describe("/resume", () => {
  it("is a registered command", () => {
    expect(resolveSlashCommand("resume")?.name).toBe("resume");
    expect(dispatchSlashCommand("/resume").resumeInterruptedTurn).toBe(true);
  });

  it("takes no arguments", () => {
    const result = dispatchSlashCommand("/resume now");
    expect(result.resumeInterruptedTurn).toBeUndefined();
    expect(result.systemMessage).toContain("usage: /resume");
  });

  it("sends the continuing message as the person's turn", () => {
    const onMessageSubmitted = vi.fn();
    const prepareInterruptedTurnResume = vi.fn(() => "[Resumed] continue");
    const dispatched: Array<{ type: string; text?: string }> = [];
    handleEditorSubmit(
      "/resume",
      idleState(),
      ((a: { type: string }) => dispatched.push(a)) as never,
      callbacks({ onMessageSubmitted, prepareInterruptedTurnResume }),
    );
    expect(prepareInterruptedTurnResume).toHaveBeenCalledWith("s1");
    expect(onMessageSubmitted).toHaveBeenCalledWith("[Resumed] continue");
    expect(dispatched.map((a) => a.type)).toContain("message_submitted");
  });

  it("says there is nothing to resume the second time", () => {
    // The runtime records the turn as resumed when it hands the message out.
    let taken = false;
    const prepareInterruptedTurnResume = vi.fn(() => {
      if (taken) return null;
      taken = true;
      return "[Resumed] continue";
    });
    const onMessageSubmitted = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;
    const cbs = callbacks({ onMessageSubmitted, prepareInterruptedTurnResume });
    handleEditorSubmit("/resume", idleState(), dispatch, cbs);
    handleEditorSubmit("/resume", idleState(), dispatch, cbs);
    expect(onMessageSubmitted).toHaveBeenCalledTimes(1);
    expect(systemTexts(dispatched)).toContain(NOTHING_TO_RESUME);
  });

  it("says there is nothing to resume without a session or a runtime that offers it", () => {
    const onMessageSubmitted = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;
    handleEditorSubmit("/resume", idleState(null), dispatch, callbacks({ onMessageSubmitted }));
    handleEditorSubmit("/resume", idleState(), dispatch, callbacks({ onMessageSubmitted }));
    expect(onMessageSubmitted).not.toHaveBeenCalled();
    expect(systemTexts(dispatched)).toEqual([NOTHING_TO_RESUME, NOTHING_TO_RESUME]);
  });
});
