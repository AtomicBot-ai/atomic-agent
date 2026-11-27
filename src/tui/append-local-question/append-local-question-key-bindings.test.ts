import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import { handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { appendLocalHotkey } from "./append-local-question-key-bindings.js";

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

  it.each([["y", "keep"], ["Y", "keep"], ["d", "off"]] as const)("answers ctrl+%s as %s and closes (ATO-2760)", (input, answer) => {
    const ctx = context();
    expect(handleAppKey(input, key({ ctrl: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onAppendLocalAnswered).toHaveBeenCalledWith(answer);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "append_local_closed" });
  });

  it.each(["y", "k", "n", "t"])("treats a bare %s as typing, not an answer (ATO-2760)", (input) => {
    // A message that starts with "now..." must not turn the fallback off.
    const ctx = context();
    handleAppKey(input, key(), ctx);
    expect(ctx.callbacks.onAppendLocalAnswered).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalledWith({ type: "append_local_closed" });
    expect(appendLocalHotkey(ctx.state, input, key())).toBeNull();
  });

  it("leaves Esc to the editor while a draft is typed (ATO-2760)", () => {
    const ctx = context();
    ctx.state.inputValue = "now do";
    expect(appendLocalHotkey(ctx.state, "", key({ escape: true }))).toBeNull();
    ctx.state.inputValue = "";
    expect(appendLocalHotkey(ctx.state, "", key({ escape: true }))).toBe("later");
  });

  it("lets a pending approval keep its ctrl+d (ATO-2760)", () => {
    const ctx = context();
    ctx.state.pendingApproval = {
      approvalId: "ap", sessionId: "session", tool: "os.shell.run", category: "shell", reason: "r",
    };
    expect(appendLocalHotkey(ctx.state, "d", key({ ctrl: true }))).toBeNull();
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
    expect(appendLocalHotkey(ctx.state, "y", key({ ctrl: true }))).toBeNull();
    expect(handleAppKey("y", key(), ctx)).toBe(true);
    expect(ctx.callbacks.onProjectTrustAnswered).toHaveBeenCalledWith("trust");
    expect(ctx.callbacks.onAppendLocalAnswered).not.toHaveBeenCalled();
    const other = context();
    expect(appendLocalHotkey(other.state, "y", key({ meta: true, ctrl: true }))).toBeNull();
    expect(appendLocalHotkey(other.state, "z", key({ ctrl: true }))).toBeNull();
    expect(appendLocalHotkey(other.state, "z", key())).toBeNull();
  });
});
