import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { apply, fakeSession } from "./test-fixtures.js";
import {
  createInitialTuiState,
  type ChatMessage,
  type SessionPickerEntry,
} from "./tui-state.js";

function entry(overrides: Partial<SessionPickerEntry> = {}): SessionPickerEntry {
  return {
    sessionId: "s1",
    workingDir: "/tmp",
    turnCount: 0,
    stepCount: 0,
    updatedAt: Date.now(),
    preview: "(empty)",
    ...overrides,
  };
}

describe("session picker reducer", () => {
  it("opens the picker with the given sessions list and resets cursor", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "session_picker_opened",
      sessions: [entry({ sessionId: "a" }), entry({ sessionId: "b" })],
    });
    expect(next.sessionPickerOpen).toBe(true);
    expect(next.sessionPickerList.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(next.sessionPickerCursor).toBe(0);
  });

  it("clamps cursor movement to the list bounds", () => {
    const initial = createInitialTuiState(fakeSession());
    const open = reduceTuiState(initial, {
      type: "session_picker_opened",
      sessions: [entry({ sessionId: "a" }), entry({ sessionId: "b" })],
    });
    const down = reduceTuiState(open, {
      type: "session_picker_cursor_moved",
      delta: 1,
    });
    expect(down.sessionPickerCursor).toBe(1);
    const pastBottom = reduceTuiState(down, {
      type: "session_picker_cursor_moved",
      delta: 1,
    });
    expect(pastBottom.sessionPickerCursor).toBe(1);
    const pastTop = reduceTuiState(pastBottom, {
      type: "session_picker_cursor_moved",
      delta: -99,
    });
    expect(pastTop.sessionPickerCursor).toBe(0);
  });

  it("session_switched replaces transcript + cwd and closes the picker", () => {
    const initial = createInitialTuiState(fakeSession());
    const primed = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "old" } },
      {
        type: "session_picker_opened",
        sessions: [entry({ sessionId: "a" })],
      },
    ]);
    const newMsgs: ChatMessage[] = [
      { id: "m1", role: "user", text: "hello", timestamp: 1 },
      { id: "m2", role: "assistant", text: "hi", timestamp: 2, toolSteps: 0 },
    ];
    const switched = reduceTuiState(primed, {
      type: "session_switched",
      sessionId: "new",
      workingDir: "/new-cwd",
      messages: newMsgs,
    });
    expect(switched.session.sessionId).toBe("new");
    expect(switched.session.workingDir).toBe("/new-cwd");
    expect(switched.messages).toHaveLength(2);
    expect(switched.sessionPickerOpen).toBe(false);
    expect(switched.runHistory).toEqual([]);
    expect(switched.feed).toEqual([]);
    // No `running` flag: the target thread is idle.
    expect(switched.status).toBe("idle");
  });

  it("session_switched with running=true resumes the running posture", () => {
    // Switching back into a thread whose turn was backgrounded (or one
    // busy with a scheduler/Telegram/HTTP turn): the composer must
    // offer steer/queue, not pretend the thread is idle.
    const initial = createInitialTuiState(fakeSession());
    const switched = reduceTuiState(initial, {
      type: "session_switched",
      sessionId: "busy",
      workingDir: "/w",
      messages: [],
      running: true,
    });
    expect(switched.status).toBe("running");
    expect(switched.runStartedAt).not.toBeNull();
  });

  it("session_switched keeps a background thread's pending approval, drops the left thread's", () => {
    const request = (id: string, sessionId: string) => ({
      approvalId: id,
      sessionId,
      tool: "os.shell.exec",
      reason: "r",
    });
    const base = apply(createInitialTuiState(fakeSession()), [
      { type: "session_created", sessionId: "s-visible" },
    ]);
    // An approval raised by some OTHER thread survives the switch: its
    // turn is still parked on the answer and this process is the only
    // surface that can give one.
    const withForeign = apply(base, [
      { type: "approval_requested", request: request("a-bg", "s-elsewhere") },
      {
        type: "session_switched",
        sessionId: "s-next",
        workingDir: "/w",
        messages: [],
      },
    ]);
    expect(withForeign.pendingApproval?.approvalId).toBe("a-bg");
    // One raised by the thread being LEFT is dropped — the orchestrator
    // denies it at the gate on switch-away, so the modal would ask a
    // question nobody can answer any more.
    const leavingOwn = apply(base, [
      { type: "approval_requested", request: request("a-own", "s-visible") },
      {
        type: "session_switched",
        sessionId: "s-next",
        workingDir: "/w",
        messages: [],
      },
    ]);
    expect(leavingOwn.pendingApproval).toBeNull();
    // Switching INTO the thread that owns the pending approval resumes
    // the awaiting posture.
    const intoOwner = apply(base, [
      { type: "approval_requested", request: request("a-bg", "s-elsewhere") },
      {
        type: "session_switched",
        sessionId: "s-elsewhere",
        workingDir: "/w",
        messages: [],
        running: true,
      },
    ]);
    expect(intoOwner.pendingApproval?.approvalId).toBe("a-bg");
    expect(intoOwner.status).toBe("awaiting_approval");
  });
});

describe("agent_event session filter", () => {
  const userEvent = { type: "user_message", text: "hi" } as const;

  it.each([
    // [tag on the event, visible session, applied?]
    ["s-visible", "s-visible", true],
    ["s-background", "s-visible", false],
    [undefined, "s-visible", true],
  ])(
    "event tagged %s with %s visible applied=%s",
    (tag, visible, applied) => {
      const base = apply(createInitialTuiState(fakeSession()), [
        { type: "session_created", sessionId: visible },
      ]);
      const next = reduceTuiState(base, {
        type: "agent_event",
        event: userEvent,
        ...(tag === undefined ? {} : { sessionId: tag }),
      });
      if (applied) {
        expect(next.messages.some((m) => m.text === "hi")).toBe(true);
      } else {
        expect(next).toBe(base);
      }
    },
  );
});
