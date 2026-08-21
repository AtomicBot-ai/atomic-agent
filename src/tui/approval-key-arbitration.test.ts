import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import {
  approvalHotkey,
  handleAppKey,
  submitApprovalPath,
} from "./app-key-bindings.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * The chat composer stays live under an approval prompt, so one letter
 * has two possible meanings. These tests pin the arbitration: an empty
 * buffer means the letters decide, a draft means they are text.
 */
function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  } as Key;
}

function session(): TuiSessionInfo {
  return {
    sessionId: "s-x",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalLevel: 1,
    maxSteps: 8,
    skillCount: 0,
  };
}

function writeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "ap-1",
    sessionId: "s-x",
    tool: "os.fs.write",
    category: "fs_write_workspace",
    reason: "replace 1337 bytes into /work/site/index.html",
    redirectablePath: "/work/site/index.html",
    ...overrides,
  };
}

function pending(overrides: Partial<TuiState> = {}): TuiState {
  return {
    ...createInitialTuiState(session()),
    pendingApproval: writeRequest(),
    ...overrides,
  };
}

describe("approvalHotkey", () => {
  it("claims the decision keys while the composer is empty", () => {
    const state = pending();
    expect(approvalHotkey(state, "y", key())).toBe("approve");
    expect(approvalHotkey(state, "s", key())).toBe("grant_category");
    expect(approvalHotkey(state, "e", key())).toBe("edit_path");
    expect(approvalHotkey(state, "n", key())).toBe("deny");
    expect(approvalHotkey(state, "", key({ escape: true }))).toBe("abort");
  });

  it("stands down completely once there is a draft", () => {
    // Otherwise "yes, but put it in ~/Documents" would approve the call
    // on its first keystroke.
    const state = pending({ inputValue: "y" });
    expect(approvalHotkey(state, "e", key())).toBeNull();
    expect(approvalHotkey(state, "n", key())).toBeNull();
    // Esc belongs to the editor here: it clears the draft, which hands
    // the decision keys back.
    expect(approvalHotkey(state, "", key({ escape: true }))).toBeNull();
  });

  it("stands down while the target field owns the keyboard", () => {
    const state = pending({ approvalPathDraft: "/work/site/index.html" });
    expect(approvalHotkey(state, "y", key())).toBeNull();
    expect(approvalHotkey(state, "n", key())).toBeNull();
  });

  it("offers [e] only when the request carries a redirectable path", () => {
    const shell = pending({
      pendingApproval: writeRequest({
        tool: "os.shell.run",
        category: "shell",
        redirectablePath: undefined,
      }),
    });
    expect(approvalHotkey(shell, "e", key())).toBeNull();
  });

  it("ignores modified keys so a global chord never decides a prompt", () => {
    const state = pending();
    expect(approvalHotkey(state, "n", key({ ctrl: true }))).toBeNull();
    expect(approvalHotkey(state, "y", key({ meta: true }))).toBeNull();
  });

  it("says nothing when no prompt is up", () => {
    expect(approvalHotkey(createInitialTuiState(session()), "y", key())).toBeNull();
  });
});

describe("handleAppKey under an approval prompt", () => {
  function ctx(state: TuiState) {
    return {
      state,
      dispatch: vi.fn(),
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    };
  }

  it("[e] opens the target field seeded with the proposed path", () => {
    const c = ctx(pending());
    expect(handleAppKey("e", key(), c)).toBe(true);
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "approval_path_edit_opened",
      path: "/work/site/index.html",
    });
    expect(c.callbacks.onApprovalDecision).not.toHaveBeenCalled();
  });

  it("lets a keystroke through to the composer once a draft exists", () => {
    const c = ctx(pending({ inputValue: "put it in " }));
    expect(handleAppKey("n", key(), c)).toBe(false);
    expect(c.callbacks.onApprovalDecision).not.toHaveBeenCalled();
  });

  it("still aborts on Ctrl+C with a draft in the buffer", () => {
    // Ctrl+C is "stop everything", not a prompt answer, so it is the
    // one key a draft does not disarm.
    const c = ctx(pending({ inputValue: "half a sentence" }));
    expect(handleAppKey("c", key({ ctrl: true }), c)).toBe(true);
    expect(c.callbacks.onApprovalDecision).toHaveBeenCalledWith("ap-1", false);
    expect(c.callbacks.onAbort).toHaveBeenCalled();
  });
});

describe("submitApprovalPath", () => {
  it("approves the call at the typed path and closes the prompt", () => {
    const dispatch = vi.fn();
    const onApprovalRetarget = vi.fn();
    submitApprovalPath(writeRequest(), "~/Documents/apple-site/index.html", {
      dispatch,
      callbacks: { onApprovalRetarget },
    });
    expect(onApprovalRetarget).toHaveBeenCalledWith(
      "ap-1",
      "~/Documents/apple-site/index.html",
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "approval_path_edit_closed" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "approval_resolved",
      approvalId: "ap-1",
      approved: true,
    });
  });
});
