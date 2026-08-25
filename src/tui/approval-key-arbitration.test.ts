import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import {
  approvalHotkey,
  canEditPath,
  handleAppKey,
  submitApprovalPath,
} from "./app-key-bindings.js";
import { canGrantShape } from "../approval/approval-gate.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * The chat composer stays live under an approval prompt. It used to be
 * that one *letter* therefore had two meanings, arbitrated by whether
 * the buffer was empty; these tests now pin the arbitration that
 * replaced it. Every decision is a ctrl-chord, so a letter is always
 * text and the buffer never has to decide. What is left for these tests
 * to prove is that the chords are claimed regardless of the draft, that
 * they do not collide with the editor's own line-editing chords, and
 * that Esc — the one binding both layers still want — stays with the
 * editor while there is something to clear.
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
  const ctrl = { ctrl: true };

  it("claims its chords", () => {
    const state = pending();
    expect(approvalHotkey(state, "y", key(ctrl))).toBe("approve");
    expect(approvalHotkey(state, "d", key(ctrl))).toBe("deny");
    expect(approvalHotkey(state, "f", key(ctrl))).toBe("grant_category");
    expect(approvalHotkey(state, "b", key(ctrl))).toBe("edit_path");
    expect(approvalHotkey(state, "", key({ escape: true }))).toBe("abort");
  });

  it("never reads a bare letter as a decision", () => {
    // The whole point of the change. "yes, but put it in ~/Documents"
    // used to approve the call on its first keystroke.
    const state = pending();
    for (const letter of ["y", "d", "f", "b", "s", "a", "e", "n"]) {
      expect(approvalHotkey(state, letter, key())).toBeNull();
    }
  });

  it("keeps claiming its chords with a draft in the buffer", () => {
    // The buffer used to be the arbiter, so a half-typed message
    // disarmed every verdict and an operator had to clear it before
    // they could answer. A chord is unambiguous either way.
    const state = pending({ inputValue: "yes, but put it in " });
    expect(approvalHotkey(state, "y", key(ctrl))).toBe("approve");
    expect(approvalHotkey(state, "d", key(ctrl))).toBe("deny");
    // Esc is the exception, and keeps its old rule for its old reason:
    // it is the editor's "clear the draft" key too, and it was never a
    // decision — the worst a misread Esc does is discard a message.
    expect(approvalHotkey(state, "", key({ escape: true }))).toBeNull();
  });

  it("leaves the editor's own line-editing chords alone", () => {
    // `ctrl+a` / `ctrl+e` / `ctrl+u` / `ctrl+k` / `ctrl+w` are
    // `multi-line-editor-keys.ts`. Claiming one would fix the collision
    // in one direction and open it in the other: an operator mid-message
    // would lose delete-word to a deny.
    const state = pending({ inputValue: "half a sentence" });
    for (const letter of ["a", "e", "u", "k", "w", "c", "v", "x"]) {
      expect(
        approvalHotkey(state, letter, key(ctrl)),
        `ctrl+${letter} must stay with the editor`,
      ).toBeNull();
    }
  });

  it("stands down while the target field owns the keyboard", () => {
    const state = pending({ approvalPathDraft: "/work/site/index.html" });
    expect(approvalHotkey(state, "y", key(ctrl))).toBeNull();
    expect(approvalHotkey(state, "d", key(ctrl))).toBeNull();
  });

  it("ignores meta so alt+y stays a character, not a verdict", () => {
    const state = pending();
    expect(approvalHotkey(state, "y", key({ meta: true }))).toBeNull();
    expect(approvalHotkey(state, "y", key({ ctrl: true, meta: true }))).toBeNull();
  });

  it("says nothing when no prompt is up", () => {
    expect(
      approvalHotkey(createInitialTuiState(session()), "y", key(ctrl)),
    ).toBeNull();
  });

  describe("the shared ctrl+b slot", () => {
    const shellWithShape = pending({
      pendingApproval: writeRequest({
        tool: "os.shell.run",
        category: "shell",
        commandShape: "rm",
        redirectablePath: undefined,
      }),
    });

    it("grants the command shape on a shell request", () => {
      expect(approvalHotkey(shellWithShape, "b", key(ctrl))).toBe("grant_shape");
    });

    it("opens the target field on a write request", () => {
      expect(approvalHotkey(pending(), "b", key(ctrl))).toBe("edit_path");
    });

    it("does nothing where the request offers neither", () => {
      const opaque = pending({
        pendingApproval: writeRequest({
          tool: "os.shell.run",
          category: "shell",
          redirectablePath: undefined,
        }),
      });
      expect(approvalHotkey(opaque, "b", key(ctrl))).toBeNull();
    });

    it("is never asked to mean both at once", () => {
      // The exclusivity the shared chord rests on, stated as a property
      // rather than as three examples: the shape grant is shell-only
      // (`canGrantShape`) and the retarget is set by `os.fs.write`
      // alone (`redirectablePath`), so no request can offer both. A
      // future tool that set `redirectablePath` on a shell request
      // would fail here — which is the point.
      const requests: ApprovalRequest[] = [
        writeRequest(),
        writeRequest({ tool: "os.shell.run", category: "shell", commandShape: "git", redirectablePath: undefined }),
        writeRequest({ tool: "os.shell.run", category: "shell", redirectablePath: undefined }),
        writeRequest({ tool: "os.fs.trash", category: "fs_trash", redirectablePath: undefined }),
        writeRequest({ tool: "os.http.request", category: "http", redirectablePath: undefined }),
      ];
      for (const request of requests) {
        expect(
          canGrantShape(request) && canEditPath(request),
          `${request.tool} offers both a shape grant and a retarget`,
        ).toBe(false);
      }
    });
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

  it("ctrl+b opens the target field seeded with the proposed path", () => {
    const c = ctx(pending());
    expect(handleAppKey("b", key({ ctrl: true }), c)).toBe(true);
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "approval_path_edit_opened",
      path: "/work/site/index.html",
    });
    expect(c.callbacks.onApprovalDecision).not.toHaveBeenCalled();
  });

  it("lets a bare letter through to the composer, draft or not", () => {
    for (const inputValue of ["", "put it in "]) {
      const c = ctx(pending({ inputValue }));
      expect(handleAppKey("d", key(), c)).toBe(false);
      expect(c.callbacks.onApprovalDecision).not.toHaveBeenCalled();
    }
  });

  it("decides on a chord even with a draft in the buffer", () => {
    const c = ctx(pending({ inputValue: "yes, but " }));
    expect(handleAppKey("y", key({ ctrl: true }), c)).toBe(true);
    expect(c.callbacks.onApprovalDecision).toHaveBeenCalledWith("ap-1", true);
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
