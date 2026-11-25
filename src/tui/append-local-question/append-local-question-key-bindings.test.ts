import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import { handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
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

const prompt = {
  question: "Local model is set as your last-resort fallback. Keep it?",
  detail: "When your cloud model fails, the agent switches the chat to your local model.",
};

function context() {
  const state = createInitialTuiState(fakeSession({ sessionId: "session" }));
  state.appendLocalPrompt = prompt;
  return {
    state,
    dispatch: vi.fn(),
    callbacks: {
      onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(),
      onAppendLocalAnswered: vi.fn(), onProjectTrustAnswered: vi.fn(), onUpdateConfirmed: vi.fn(),
    },
    ctrlCArmed: false, setCtrlCArmed: vi.fn(), sidebarVisible: false,
    menuLeaderArmed: false, setMenuLeaderArmed: vi.fn(),
    activateMenuNode: vi.fn(), activateComposerSwitch: vi.fn(),
  } satisfies AppKeyContext;
}

/** ATO-1461: the one-time last-resort fallback question in the terminal. */
describe("last-resort fallback question", () => {
  it("opens and closes through the reducer", () => {
    const initial = createInitialTuiState(fakeSession({ sessionId: "session" }));
    expect(initial.appendLocalPrompt).toBeNull();
    const asked = reduceTuiState(initial, { type: "append_local_asked", prompt });
    expect(asked.appendLocalPrompt).toEqual(prompt);
    expect(reduceTuiState(asked, { type: "append_local_closed" }).appendLocalPrompt).toBeNull();
  });

  it.each([["y", "keep"], ["K", "keep"], ["n", "off"], ["t", "off"]] as const)("answers %s as %s and closes", (input, answer) => {
    const ctx = context();
    expect(handleAppKey(input, key(), ctx)).toBe(true);
    expect(ctx.callbacks.onAppendLocalAnswered).toHaveBeenCalledWith(answer);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "append_local_closed" });
  });

  it("puts the question off with Esc without answering", () => {
    const ctx = context();
    expect(handleAppKey("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onAppendLocalAnswered).not.toHaveBeenCalled();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "append_local_closed" });
  });

  it("waits behind the folder trust question, and ignores modified or other keys", () => {
    const ctx = context();
    ctx.state.projectTrustPrompt = { workingDir: "/repo", question: "Trust them?", questionId: "abc" };
    expect(handleAppKey("y", key(), ctx)).toBe(true);
    expect(ctx.callbacks.onProjectTrustAnswered).toHaveBeenCalledWith("trust");
    expect(ctx.callbacks.onAppendLocalAnswered).not.toHaveBeenCalled();
    const other = context();
    expect(handleAppKey("y", key({ ctrl: true }), other)).toBe(false);
    expect(handleAppKey("z", key(), other)).toBe(false);
    expect(other.callbacks.onAppendLocalAnswered).not.toHaveBeenCalled();
  });
});
