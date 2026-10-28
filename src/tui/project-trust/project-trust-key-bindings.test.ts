import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import { APPROVAL_CHORDS, handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import { reduceTuiState } from "../agent-event-reducer.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false, hyper: false,
    capsLock: false, numLock: false, ...overrides,
  };
}

const prompt = { workingDir: "/repo", question: "This folder has 3 project skills and AGENTS.md. Trust them?", questionId: "abc" };

function context() {
  const state = createInitialTuiState(fakeSession({ sessionId: "session" }));
  state.projectTrustPrompt = prompt;
  return {
    state,
    dispatch: vi.fn(),
    callbacks: {
      onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(),
      onProjectTrustAnswered: vi.fn(), onUpdateConfirmed: vi.fn(),
    },
    ctrlCArmed: false, setCtrlCArmed: vi.fn(), sidebarVisible: false,
    menuLeaderArmed: false, setMenuLeaderArmed: vi.fn(),
    activateMenuNode: vi.fn(), activateComposerSwitch: vi.fn(),
  } satisfies AppKeyContext;
}

describe("project folder trust question", () => {
  it("opens and closes through the reducer", () => {
    const initial = createInitialTuiState(fakeSession({ sessionId: "session" }));
    expect(initial.projectTrustPrompt).toBeNull();
    const asked = reduceTuiState(initial, { type: "project_trust_asked", prompt });
    expect(asked.projectTrustPrompt).toEqual(prompt);
    expect(reduceTuiState(asked, { type: "project_trust_closed" }).projectTrustPrompt).toBeNull();
  });

  it.each([["y", "trust"], ["Y", "trust"], ["n", "decline"], ["N", "decline"]] as const)("answers %s as %s and closes", (input, answer) => {
    const ctx = context();
    expect(handleAppKey(input, key(), ctx)).toBe(true);
    expect(ctx.callbacks.onProjectTrustAnswered).toHaveBeenCalledWith(answer);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "project_trust_closed" });
  });

  it("puts the question off with Esc without answering", () => {
    const ctx = context();
    expect(handleAppKey("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onProjectTrustAnswered).not.toHaveBeenCalled();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "project_trust_closed" });
  });

  it("is answered before a simultaneous update offer, and ignores modified or other keys", () => {
    const ctx = context();
    ctx.state.updatePrompt = { current: "1.0.0", latest: "2.0.0" };
    expect(handleAppKey("y", key(), ctx)).toBe(true);
    expect(ctx.callbacks.onProjectTrustAnswered).toHaveBeenCalledWith("trust");
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
    const other = context();
    expect(handleAppKey("y", key({ ctrl: true }), other)).toBe(false);
    expect(handleAppKey("z", key(), other)).toBe(false);
    expect(other.callbacks.onProjectTrustAnswered).not.toHaveBeenCalled();
  });

  it("leaves a visible approval its keys", () => {
    const ctx = context();
    ctx.state.pendingApproval = {
      approvalId: "approval", sessionId: "session", tool: "os.shell.run",
      category: "shell", reason: "needs confirmation", commandShape: "git",
    };
    expect(handleAppKey(APPROVAL_CHORDS.approve, key({ ctrl: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onApprovalDecision).toHaveBeenCalledWith("approval", true);
    expect(handleAppKey("y", key(), ctx)).toBe(false);
    expect(ctx.callbacks.onProjectTrustAnswered).not.toHaveBeenCalled();
  });
});
