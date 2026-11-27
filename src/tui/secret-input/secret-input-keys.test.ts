import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { approvalHotkey } from "../app-key-bindings.js";
import { handleEditorSubmit } from "../submit-handler.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { applySecretKey, maskSecret, submitShellSecret } from "./secret-input-keys.js";

/**
 * ATO-2486: a password a shell job asks for is typed into a masked
 * field; it never reaches the composer, a steer, a deny reason or a
 * transcript line.
 */

const VALUE = "correct horse 42!";

const REQUEST: ApprovalRequest = {
  approvalId: "sec-1",
  sessionId: "s1",
  tool: "os.shell.run",
  category: "shell_secret",
  reason: "job 1 (sudo apt update) asks for sudo password",
  secretInput: {
    jobId: 1,
    label: "sudo password",
    commandLine: "sudo apt update",
    promptLine: "[sudo] password for me:",
  },
};

function secretState(): TuiState {
  return {
    ...createInitialTuiState({
      sessionId: "s1",
      workingDir: "/tmp",
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chrome",
      browserHeadless: false,
      approvalLevel: 5,
      maxSteps: 10,
      completionMaxTokens: 2048,
      skillCount: 0,
      localBackendConfigured: false,
    }),
    pendingApproval: REQUEST,
  };
}

const key = (over: Record<string, boolean> = {}) => over as never;

describe("applySecretKey", () => {
  it("appends printable keys and pastes, drops the last on backspace, submits on enter", () => {
    expect(applySecretKey("", "a", key())).toEqual({ kind: "edit", buffer: "a" });
    expect(applySecretKey("a", "bc d", key())).toEqual({ kind: "edit", buffer: "abc d" });
    expect(applySecretKey("abc", "", key({ backspace: true }))).toEqual({ kind: "edit", buffer: "ab" });
    expect(applySecretKey("abc", "\r", key({ return: true }))).toEqual({ kind: "submit", buffer: "abc" });
  });

  it("leaves chords, Esc and terminal sequences to the app layer", () => {
    expect(applySecretKey("a", "n", key({ ctrl: true }))).toEqual({ kind: "ignore" });
    expect(applySecretKey("a", "", key({ escape: true }))).toEqual({ kind: "ignore" });
    expect(applySecretKey("a", "\u001b[<0;3;4M", key())).toEqual({ kind: "ignore" });
  });
});

describe("maskSecret", () => {
  it("shows bullets, never the characters", () => {
    expect(maskSecret(VALUE)).toBe("•".repeat(17));
    expect(maskSecret("x".repeat(40))).toBe(`${"•".repeat(32)}+8`);
  });
});

describe("submitShellSecret", () => {
  it("sends the value to the runtime only; the transcript line does not carry it", () => {
    const onSecretInput = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const sent = submitShellSecret(REQUEST, VALUE, {
      dispatch: (a) => dispatched.push(a as { type: string; text?: string }),
      onSecretInput,
    });
    expect(sent).toBe(true);
    expect(onSecretInput).toHaveBeenCalledWith("sec-1", VALUE);
    expect(dispatched.map((a) => a.type)).toEqual(["approval_resolved", "system_message"]);
    expect(JSON.stringify(dispatched)).not.toContain(VALUE);
    expect(dispatched[1]?.text).toBe("Sent to job 1 (hidden from the agent).");
  });

  it("keeps the field open on a value that cannot be sent", () => {
    const onSecretInput = vi.fn();
    const dispatched: Array<{ type: string }> = [];
    expect(
      submitShellSecret(REQUEST, "a\nb", { dispatch: (a) => dispatched.push(a), onSecretInput }),
    ).toBe(false);
    expect(onSecretInput).not.toHaveBeenCalled();
    expect(dispatched.map((a) => a.type)).toEqual(["system_message"]);
  });
});

describe("keys while a secret is asked for", () => {
  it("nothing approves it; Esc and the deny chord skip it", () => {
    const state = secretState();
    expect(approvalHotkey(state, "y", { ctrl: true, meta: false } as never)).toBeNull();
    expect(approvalHotkey(state, "d", { ctrl: true, meta: false } as never)).toBe("deny");
    expect(approvalHotkey(state, "", { escape: true } as never)).toBe("deny");
    // a plain letter is the field's, not a verdict
    expect(approvalHotkey(state, "y", {} as never)).toBeNull();
  });

  it("a composer submit is neither a steer nor a deny reason", () => {
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: vi.fn(),
      onApprovalReply: vi.fn(),
      onAbort: vi.fn(),
      onQuit: vi.fn(),
      onMessageSubmitted: vi.fn(),
    };
    const dispatched: Array<{ type: string }> = [];
    handleEditorSubmit(VALUE, secretState(), ((a: { type: string }) => dispatched.push(a)) as never, callbacks);
    expect(callbacks.onApprovalReply).not.toHaveBeenCalled();
    expect(callbacks.onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });
});
