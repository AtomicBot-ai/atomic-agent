import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { createInitialTuiState, type SessionPickerEntry } from "./tui-state.js";

const SESSION = {
  sessionId: null,
  workingDir: "/tmp/test",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chromium",
  browserHeadless: false,
  approvalRequired: false,
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
