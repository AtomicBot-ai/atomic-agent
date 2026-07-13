import { describe, it, expect, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey } from "./app-key-bindings.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
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

function stubSession(): TuiSessionInfo {
  return {
    sessionId: "s-x",
    workingDir: "/tmp/w",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chromium",
    browserHeadless: true,
    approvalRequired: false,
    maxSteps: 8,
    skillCount: 0,
  };
}

describe("handleAppKey", () => {
  it("returns false when no binding matches", () => {
    const state = createInitialTuiState(stubSession());
    const handled = handleAppKey("z", emptyKey(), {
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
    });
    expect(handled).toBe(false);
  });

  it("PageUp dispatches a chat_scrolled action with a positive delta in chat mode", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("", emptyKey({ pageUp: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "chat_scrolled",
      delta: expect.any(Number),
    });
    const call = dispatch.mock.calls[0]?.[0];
    expect(call?.delta).toBeGreaterThan(0);
  });

  it("PageDown dispatches a chat_scrolled action with a negative delta in chat mode", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("", emptyKey({ pageDown: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    const call = dispatch.mock.calls[0]?.[0];
    expect(call?.type).toBe("chat_scrolled");
    expect(call?.delta).toBeLessThan(0);
  });

  it("treats bare Up/Down arrows as chat scroll when the editor is empty", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("", emptyKey({ upArrow: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "chat_scrolled",
      delta: expect.any(Number),
    });
    const call = dispatch.mock.calls[0]?.[0];
    expect(call?.delta).toBeGreaterThan(0);
  });

  it("leaves Up/Down arrows for the editor when the input has content", () => {
    const state = createInitialTuiState(stubSession());
    state.inputValue = "draft";
    const dispatch = vi.fn();
    const handled = handleAppKey("", emptyKey({ upArrow: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not consume PageUp / PageDown when an approval is pending", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = {
      approvalId: "ap-1",
      tool: "shell.run",
      args: {},
      reason: "test",
    } as never;
    const dispatch = vi.fn();
    const handled = handleAppKey("", emptyKey({ pageUp: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("Tab from editor lands focus into the sidebar when it is visible", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "chat_focus_set",
      focus: "sidebar",
    });
    // It does not also cycle nav slots — that is Ctrl+B's job.
    const tabChanges = dispatch.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "tab_changed",
    );
    expect(tabChanges).toHaveLength(0);
  });

  it("Tab cycles nav slots when the sidebar is hidden (narrow terminal)", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "ui_mode_set", mode: "debug" });
    expect(dispatch).toHaveBeenCalledWith({ type: "tab_changed", tab: "feed" });
  });

  it("Tab inside sidebar(sessions) advances to the Tasks pane", () => {
    const state = createInitialTuiState(stubSession());
    state.chatFocus = "sidebar";
    state.sidebarSection = "sessions";
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "sidebar_section_focused",
      section: "tasks",
    });
  });

  it("Tab inside sidebar(tasks) hands focus back to the editor", () => {
    const state = createInitialTuiState(stubSession());
    state.chatFocus = "sidebar";
    state.sidebarSection = "tasks";
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "chat_focus_set",
      focus: "editor",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "sidebar_section_focused",
      section: "sessions",
    });
  });

  it("Shift+Tab cycles nav slots backward regardless of sidebar focus", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true, shift: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "ui_mode_set", mode: "debug" });
    // Shift+Tab from chat wraps to the last Manage tab (Privacy).
    expect(dispatch).toHaveBeenCalledWith({
      type: "tab_changed",
      tab: "privacy",
    });
  });

  it("Ctrl+B always cycles nav slots forward (escape valve)", () => {
    const state = createInitialTuiState(stubSession());
    const dispatch = vi.fn();
    const handled = handleAppKey("b", emptyKey({ ctrl: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "ui_mode_set", mode: "debug" });
    expect(dispatch).toHaveBeenCalledWith({ type: "tab_changed", tab: "feed" });
  });

  it("Up/Down inside sidebar Tasks pane moves the tasks cursor", () => {
    const state = createInitialTuiState(stubSession());
    state.chatFocus = "sidebar";
    state.sidebarSection = "tasks";
    const dispatch = vi.fn();
    handleAppKey("", emptyKey({ downArrow: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "sidebar_tasks_cursor_moved",
      delta: 1,
    });
  });

  it("Tab on Memory list mode still cycles Manage tabs", () => {
    const state = createInitialTuiState(stubSession());
    state.uiMode = "debug";
    state.activeTab = "memory";
    state.memoryPanel.mode = "list";
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "tab_changed", tab: "mcp" });
  });

  it("Tab on Memory detail mode is blocked so Esc can close detail first", () => {
    const state = createInitialTuiState(stubSession());
    state.uiMode = "debug";
    state.activeTab = "memory";
    state.memoryPanel.mode = "detail";
    const dispatch = vi.fn();
    const handled = handleAppKey("\t", emptyKey({ tab: true }), {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("Enter on a sidebar Task fires onSidebarTaskActivated with the row id", () => {
    const state = createInitialTuiState(stubSession());
    state.chatFocus = "sidebar";
    state.sidebarSection = "tasks";
    state.tasksPanel = {
      ...state.tasksPanel,
      rows: [
        {
          id: "task-id-42",
          status: "running",
          origin: "tui",
          triggerSource: "user",
          sessionId: null,
          userMessage: "do the thing",
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
    };
    const onSidebarTaskActivated = vi.fn();
    handleAppKey("", emptyKey({ return: true }), {
      state,
      dispatch: vi.fn(),
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
        onSidebarTaskActivated,
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: true,
    });
    expect(onSidebarTaskActivated).toHaveBeenCalledWith("task-id-42");
  });
});
