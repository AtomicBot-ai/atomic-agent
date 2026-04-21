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
  });
});
