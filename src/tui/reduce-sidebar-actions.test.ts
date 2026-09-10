import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { createInitialTuiState, type SessionPickerEntry } from "./tui-state.js";

const SESSION = {
  sessionId: null,
  workingDir: "/tmp/test",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chromium",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 8,
  skillCount: 0,
};

function entry(overrides: Partial<SessionPickerEntry>): SessionPickerEntry {
  return {
    sessionId: "abc",
    workingDir: "/tmp/test",
    turnCount: 0,
    stepCount: 0,
    updatedAt: 0,
    preview: "",
    pinned: false,
    ...overrides,
  };
}

describe("reduce sidebar + chat scroll actions", () => {
  it("populates recentSessions and clamps the cursor", () => {
    const initial = createInitialTuiState(SESSION);
    const populated = reduceTuiState(
      { ...initial, sidebarCursor: 5 },
      {
        type: "recent_sessions_updated",
        sessions: [entry({ sessionId: "a" }), entry({ sessionId: "b" })],
      },
    );
    expect(populated.recentSessions).toHaveLength(2);
    expect(populated.sidebarCursor).toBe(1);
  });

  it("toggles chat focus between editor and sidebar", () => {
    const initial = createInitialTuiState(SESSION);
    const focused = reduceTuiState(initial, { type: "chat_focus_toggled" });
    expect(focused.chatFocus).toBe("sidebar");
    const back = reduceTuiState(focused, { type: "chat_focus_toggled" });
    expect(back.chatFocus).toBe("editor");
  });

  it("sets chat focus explicitly", () => {
    const initial = createInitialTuiState(SESSION);
    const next = reduceTuiState(initial, {
      type: "chat_focus_set",
      focus: "sidebar",
    });
    expect(next.chatFocus).toBe("sidebar");
  });

  it("moves the sidebar cursor within bounds", () => {
    const initial = createInitialTuiState(SESSION);
    const populated = reduceTuiState(initial, {
      type: "recent_sessions_updated",
      sessions: [
        entry({ sessionId: "a" }),
        entry({ sessionId: "b" }),
        entry({ sessionId: "c" }),
      ],
    });
    const down = reduceTuiState(populated, {
      type: "sidebar_cursor_moved",
      delta: 1,
    });
    expect(down.sidebarCursor).toBe(1);
    const tooFar = reduceTuiState(
      { ...populated, sidebarCursor: 2 },
      { type: "sidebar_cursor_moved", delta: 1 },
    );
    expect(tooFar.sidebarCursor).toBe(2);
    const tooFarUp = reduceTuiState(
      { ...populated, sidebarCursor: 0 },
      { type: "sidebar_cursor_moved", delta: -1 },
    );
    expect(tooFarUp.sidebarCursor).toBe(0);
  });

  it("scrolls chat by delta and floors at zero", () => {
    // `chatScrollOffset` is in lines since the smooth-scroll
    // refactor. Upper bound is enforced visually in `ChatLog`
    // (which knows the rendered content height); the reducer only
    // protects the lower bound.
    const initial = createInitialTuiState(SESSION);
    const up1 = reduceTuiState(initial, {
      type: "chat_scrolled",
      delta: 5,
    });
    expect(up1.chatScrollOffset).toBe(5);
    const up2 = reduceTuiState(up1, {
      type: "chat_scrolled",
      delta: 12,
    });
    expect(up2.chatScrollOffset).toBe(17);
    const downTooFar = reduceTuiState(up2, {
      type: "chat_scrolled",
      delta: -100,
    });
    expect(downTooFar.chatScrollOffset).toBe(0);
  });

  it("snaps chat scroll back to bottom on chat_scroll_reset", () => {
    const initial = createInitialTuiState(SESSION);
    const scrolled = { ...initial, chatScrollOffset: 4 };
    const reset = reduceTuiState(scrolled, { type: "chat_scroll_reset" });
    expect(reset.chatScrollOffset).toBe(0);
  });

  it("resets chat scroll on a new turn", () => {
    const initial = createInitialTuiState(SESSION);
    const scrolled = { ...initial, chatScrollOffset: 4 };
    const next = reduceTuiState(scrolled, { type: "message_submitted" });
    expect(next.chatScrollOffset).toBe(0);
  });

  it("resets chat scroll + focus + sidebar cursors on session_switched", () => {
    const initial = createInitialTuiState(SESSION);
    const dirty = {
      ...initial,
      chatScrollOffset: 5,
      chatFocus: "sidebar" as const,
      sidebarSection: "tasks" as const,
      sidebarCursor: 3,
      sidebarTasksCursor: 2,
    };
    const next = reduceTuiState(dirty, {
      type: "session_switched",
      sessionId: "new",
      workingDir: "/tmp/x",
      messages: [],
    });
    expect(next.chatScrollOffset).toBe(0);
    expect(next.chatFocus).toBe("editor");
    expect(next.sidebarSection).toBe("sessions");
    expect(next.sidebarCursor).toBe(0);
    expect(next.sidebarTasksCursor).toBe(0);
  });

  it("toggles sidebarCollapsed and back", () => {
    const initial = createInitialTuiState(SESSION);
    expect(initial.sidebarCollapsed).toBe(false);
    const folded = reduceTuiState(initial, {
      type: "sidebar_collapse_toggled",
    });
    expect(folded.sidebarCollapsed).toBe(true);
    const restored = reduceTuiState(folded, {
      type: "sidebar_collapse_toggled",
    });
    expect(restored.sidebarCollapsed).toBe(false);
  });

  it("returns focus to the editor when the rail is folded from under it", () => {
    const initial = createInitialTuiState(SESSION);
    const onRail = { ...initial, chatFocus: "sidebar" as const };
    const folded = reduceTuiState(onRail, {
      type: "sidebar_collapse_toggled",
    });
    expect(folded.sidebarCollapsed).toBe(true);
    expect(folded.chatFocus).toBe("editor");
  });

  it("leaves editor focus alone when the rail is folded or restored", () => {
    const initial = createInitialTuiState(SESSION);
    const folded = reduceTuiState(initial, {
      type: "sidebar_collapse_toggled",
    });
    expect(folded.chatFocus).toBe("editor");
    // Restoring never steals focus either — the operator asked for the
    // rail back on screen, not for the keyboard to move there.
    const restored = reduceTuiState(
      { ...folded, chatFocus: "editor" as const },
      { type: "sidebar_collapse_toggled" },
    );
    expect(restored.chatFocus).toBe("editor");
  });

  it("sets sidebarSection on sidebar_section_focused", () => {
    const initial = createInitialTuiState(SESSION);
    const next = reduceTuiState(initial, {
      type: "sidebar_section_focused",
      section: "tasks",
    });
    expect(next.sidebarSection).toBe("tasks");
  });

  it("clamps sidebarTasksCursor against the rendered slice (top-5 active+recurring)", () => {
    const initial = createInitialTuiState(SESSION);
    const seeded = {
      ...initial,
      tasksPanel: {
        ...initial.tasksPanel,
        rows: [
          {
            id: "t-1",
            status: "running" as const,
            origin: "tui" as const,
            triggerSource: "user" as const,
            sessionId: null,
            userMessage: "x",
            scheduleKind: null,
            scheduleLabel: "-",
            recurring: false,
            scheduledFor: null,
            createdAt: 0,
            updatedAt: 0,
            startedAt: null,
            completedAt: null,
            attempts: 0,
            maxAttempts: 3,
            lastError: null,
          },
        ],
      },
      sidebarTasksCursor: 0,
    };
    const tooFar = reduceTuiState(seeded, {
      type: "sidebar_tasks_cursor_moved",
      delta: 1,
    });
    expect(tooFar.sidebarTasksCursor).toBe(0);
    const tooFarUp = reduceTuiState(seeded, {
      type: "sidebar_tasks_cursor_moved",
      delta: -1,
    });
    expect(tooFarUp.sidebarTasksCursor).toBe(0);
  });
});

describe("reduce sidebar drag actions", () => {
  const seeded = () =>
    reduceTuiState(
      { ...createInitialTuiState(SESSION), chatFocus: "sidebar" as const },
      {
        type: "recent_sessions_updated",
        sessions: [
          entry({ sessionId: "a" }),
          entry({ sessionId: "b" }),
          entry({ sessionId: "c" }),
        ],
      },
    );

  it("starts with the pressed row as both origin and slot", () => {
    const next = reduceTuiState(seeded(), {
      type: "sidebar_drag_started",
      sessionId: "b",
      row: 1,
    });
    expect(next.sidebarDrag).toEqual({ sessionId: "b", from: 1, over: 1 });
    // The list itself is untouched until the host re-emits it.
    expect(next.recentSessions.map((e) => e.sessionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("moves the slot under the pointer, clamped to the list", () => {
    const started = reduceTuiState(seeded(), {
      type: "sidebar_drag_started",
      sessionId: "b",
      row: 1,
    });
    const over = reduceTuiState(started, {
      type: "sidebar_drag_moved",
      row: 0,
    });
    expect(over.sidebarDrag).toEqual({ sessionId: "b", from: 1, over: 0 });
    const past = reduceTuiState(over, { type: "sidebar_drag_moved", row: 9 });
    expect(past.sidebarDrag?.over).toBe(2);
    // Same slot again: the same state object, so nothing repaints.
    expect(reduceTuiState(past, { type: "sidebar_drag_moved", row: 9 })).toBe(
      past,
    );
  });

  it("ignores a move with no drag in flight", () => {
    const state = seeded();
    expect(reduceTuiState(state, { type: "sidebar_drag_moved", row: 0 })).toBe(
      state,
    );
  });

  it("ends on release", () => {
    const started = reduceTuiState(seeded(), {
      type: "sidebar_drag_started",
      sessionId: "b",
      row: 1,
    });
    expect(
      reduceTuiState(started, { type: "sidebar_drag_ended" }).sidebarDrag,
    ).toBeNull();
  });

  it("is cleared by a list refresh and by focus leaving the rail", () => {
    const started = reduceTuiState(seeded(), {
      type: "sidebar_drag_started",
      sessionId: "b",
      row: 1,
    });
    const refreshed = reduceTuiState(started, {
      type: "recent_sessions_updated",
      sessions: [entry({ sessionId: "b" }), entry({ sessionId: "a" })],
    });
    expect(refreshed.sidebarDrag).toBeNull();
    const unfocused = reduceTuiState(started, {
      type: "chat_focus_set",
      focus: "editor",
    });
    expect(unfocused.sidebarDrag).toBeNull();
    const stillFocused = reduceTuiState(started, {
      type: "chat_focus_set",
      focus: "sidebar",
    });
    expect(stillFocused.sidebarDrag).not.toBeNull();
  });
});
