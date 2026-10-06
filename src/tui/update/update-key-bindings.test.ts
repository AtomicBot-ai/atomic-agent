import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import { APPROVAL_CHORDS, handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false, hyper: false,
    capsLock: false, numLock: false, ...overrides,
  };
}

function context() {
  const state = createInitialTuiState(fakeSession({ sessionId: "session" }));
  state.updatePrompt = { current: "1.0.0", latest: "2.0.0" };
  return {
    state,
    dispatch: vi.fn(),
    callbacks: {
      onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(),
      onUpdateConfirmed: vi.fn(), onUpdateRestart: vi.fn(),
    },
    ctrlCArmed: false, setCtrlCArmed: vi.fn(), sidebarVisible: false,
    menuLeaderArmed: false, setMenuLeaderArmed: vi.fn(),
    activateMenuNode: vi.fn(), activateComposerSwitch: vi.fn(),
  } satisfies AppKeyContext;
}

describe("update input through the global router", () => {
  it.each(["y", "Y"])("accepts %s only while an offer exists", (input) => {
    const ctx = context();
    expect(handleAppKey(input, key(), ctx)).toBe(true);
    expect(ctx.callbacks.onUpdateConfirmed).toHaveBeenCalledOnce();
    ctx.state.updatePrompt = null;
    ctx.callbacks.onUpdateConfirmed.mockClear();
    expect(handleAppKey(input, key(), ctx)).toBe(false);
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
  });

  it.each(["n", "escape"])("dismisses via %s without accepting", (input) => {
    const ctx = context();
    expect(handleAppKey(input === "escape" ? "" : input, key({ escape: input === "escape" }), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "update_dismissed" });
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
  });

  it.each(["ctrl", "meta"] as const)("does not accept modified y (%s)", (modifier) => {
    const ctx = context();
    expect(handleAppKey("y", key({ [modifier]: true }), ctx)).toBe(false);
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalledWith({ type: "update_dismissed" });
  });

  it("lets ordinary input pass through an offer", () => {
    const ctx = context();
    expect(handleAppKey("z", key(), ctx)).toBe(false);
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
  });

  it("answers the visible approval before an update offer or restart", () => {
    for (const phase of ["idle", "done"] as const) {
      const ctx = context();
      ctx.state.updateStatus = phase;
      ctx.state.pendingApproval = {
        approvalId: "approval", sessionId: "session", tool: "os.shell.run",
        category: "shell", reason: "needs confirmation", commandShape: "git",
      };
      // Plain text belongs to the approval's composer, not the update offer.
      expect(handleAppKey("y", key(), ctx)).toBe(false);
      expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
      expect(handleAppKey(APPROVAL_CHORDS.approve, key({ ctrl: true }), ctx)).toBe(true);
      expect(ctx.callbacks.onApprovalDecision).toHaveBeenCalledWith("approval", true);
      expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
      expect(ctx.callbacks.onUpdateRestart).not.toHaveBeenCalled();
    }
  });

  it("requests restart before quitting after completion, without accepting again", () => {
    const ctx = context();
    ctx.state.updateStatus = "done";
    expect(handleAppKey("z", key(), ctx)).toBe(true);
    expect(ctx.callbacks.onUpdateRestart).toHaveBeenCalledOnce();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "quit_requested" });
    expect(ctx.callbacks.onUpdateRestart.mock.invocationCallOrder[0]).toBeLessThan(ctx.dispatch.mock.invocationCallOrder[0]!);
    expect(ctx.callbacks.onUpdateConfirmed).not.toHaveBeenCalled();
  });
});
