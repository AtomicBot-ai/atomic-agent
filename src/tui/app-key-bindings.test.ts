import { describe, it, expect, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey, handlePanelEscape } from "./app-key-bindings.js";
import type { MenuNode } from "./menu/menu-registry.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

function pendingRequest(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    approvalId: "ap-1",
    sessionId: "s-x",
    tool: "os.shell.run",
    category: "shell",
    reason: "no guard rule matched",
    commandShape: "git",
    ...overrides,
  };
}

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
    approvalLevel: 5,
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

  it("y on a pending approval resolves it with no grant", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = pendingRequest();
    const onApprovalDecision = vi.fn();
    const handled = handleAppKey("y", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks: { onApprovalDecision, onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(onApprovalDecision).toHaveBeenCalledWith("ap-1", true);
  });

  it("s on a grantable approval resolves with a category grant and confirms it", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = pendingRequest();
    const onApprovalDecision = vi.fn();
    const dispatch = vi.fn();
    const handled = handleAppKey("s", emptyKey(), {
      state,
      dispatch,
      callbacks: { onApprovalDecision, onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(onApprovalDecision).toHaveBeenCalledWith("ap-1", true, "category");
    // A system message confirms the grant at the point of action.
    expect(dispatch).toHaveBeenCalledWith({
      type: "system_message",
      text: "granted: shell command for this session",
    });
  });

  it("a on a shell approval with a shape resolves with a shape grant and confirms it", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = pendingRequest({ commandShape: "git" });
    const onApprovalDecision = vi.fn();
    const dispatch = vi.fn();
    const handled = handleAppKey("a", emptyKey(), {
      state,
      dispatch,
      callbacks: { onApprovalDecision, onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(true);
    expect(onApprovalDecision).toHaveBeenCalledWith("ap-1", true, "shape");
    expect(dispatch).toHaveBeenCalledWith({
      type: "system_message",
      text: "granted: git commands for this session",
    });
  });

  it("s is inert on a trust_config approval (never grantable)", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = pendingRequest({
      category: "trust_config",
      tool: "os.fs.write",
      commandShape: undefined,
    });
    const onApprovalDecision = vi.fn();
    const handled = handleAppKey("s", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks: { onApprovalDecision, onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    // The key is not routed as a grant; nothing resolves the approval.
    expect(handled).toBe(false);
    expect(onApprovalDecision).not.toHaveBeenCalled();
  });

  it("a is inert on a non-shell approval (no shape to grant)", () => {
    const state = createInitialTuiState(stubSession());
    state.pendingApproval = pendingRequest({
      category: "fs_write_home",
      tool: "os.fs.write",
      commandShape: undefined,
    });
    const onApprovalDecision = vi.fn();
    const handled = handleAppKey("a", emptyKey(), {
      state,
      dispatch: vi.fn(),
      callbacks: { onApprovalDecision, onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    });
    expect(handled).toBe(false);
    expect(onApprovalDecision).not.toHaveBeenCalled();
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

describe("handleAppKey with the ctrl+g leader armed", () => {
  function pressWhileArmed(
    input: string,
    key: Key,
    state = createInitialTuiState(stubSession()),
  ) {
    const activated: MenuNode[] = [];
    const dispatch = vi.fn();
    const setMenuLeaderArmed = vi.fn();
    const setCtrlCArmed = vi.fn();
    const onAbort = vi.fn();
    const onQuit = vi.fn();
    const handled = handleAppKey(input, key, {
      state,
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort,
        onQuit,
      },
      ctrlCArmed: false,
      setCtrlCArmed,
      sidebarVisible: false,
      menuLeaderArmed: true,
      setMenuLeaderArmed,
      activateMenuNode: (node) => activated.push(node),
    });
    return {
      handled,
      activated,
      dispatch,
      setMenuLeaderArmed,
      setCtrlCArmed,
      onAbort,
      onQuit,
    };
  }

  it("a bare chord key activates its node", () => {
    const run = pressWhileArmed("c", emptyKey());
    expect(run.activated.map((n) => n.id)).toEqual(["go.manage.mcp"]);
    expect(run.handled).toBe(true);
    expect(run.setMenuLeaderArmed).toHaveBeenCalledWith(false);
  });

  it("an unclaimed bare key is swallowed rather than leaked to the prompt", () => {
    const run = pressWhileArmed("z", emptyKey());
    expect(run.activated).toEqual([]);
    expect(run.handled).toBe(true);
  });

  it("Ctrl+C disarms and aborts the turn instead of jumping to the MCP tab", () => {
    const state = createInitialTuiState(stubSession());
    state.status = "running";
    const run = pressWhileArmed("c", emptyKey({ ctrl: true }), state);
    expect(run.activated).toEqual([]);
    expect(run.setMenuLeaderArmed).toHaveBeenCalledWith(false);
    expect(run.setCtrlCArmed).toHaveBeenCalledWith(true);
    expect(run.onAbort).toHaveBeenCalled();
    expect(run.dispatch).toHaveBeenCalledWith({ type: "abort_requested" });
    expect(run.handled).toBe(true);
  });

  it("Ctrl+Q disarms without quitting the app", () => {
    const run = pressWhileArmed("q", emptyKey({ ctrl: true }));
    expect(run.activated).toEqual([]);
    expect(run.onQuit).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalledWith({ type: "quit_requested" });
    // Nothing else binds ctrl+q, so the key falls through unclaimed —
    // which is the point: the leader no longer stands in the way.
    expect(run.handled).toBe(false);
  });

  it("Ctrl+L disarms and falls through instead of opening the LLM tab", () => {
    const run = pressWhileArmed("l", emptyKey({ ctrl: true }));
    expect(run.activated).toEqual([]);
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.handled).toBe(false);
  });

  it("Esc disarms and is swallowed, so it cancels the leader", () => {
    const run = pressWhileArmed("", emptyKey({ escape: true }));
    expect(run.activated).toEqual([]);
    expect(run.setMenuLeaderArmed).toHaveBeenCalledWith(false);
    expect(run.handled).toBe(true);
  });
});

describe("handlePanelEscape", () => {
  it("sends an unclaimed Esc home to Run", () => {
    const dispatch = vi.fn();
    const consumed = handlePanelEscape(emptyKey({ escape: true }), {
      panelHandled: false,
      editorFocus: false,
      dispatch,
    });
    expect(consumed).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "ui_mode_set", mode: "chat" });
  });

  it("leaves the panel alone when its own layer already claimed Esc", () => {
    // A modal, an open search input or a detail view returns `true` from
    // the panel's key layer — the operator meant "close that", not
    // "leave the panel", so the fallback must stay out of the way.
    const dispatch = vi.fn();
    const consumed = handlePanelEscape(emptyKey({ escape: true }), {
      panelHandled: true,
      editorFocus: false,
      dispatch,
    });
    expect(consumed).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("defers to the chat editor when the editor holds focus", () => {
    // On tabs that keep the editor focused, Esc already means
    // abort / scroll-reset / quit inside the editor's own hook.
    const dispatch = vi.fn();
    const consumed = handlePanelEscape(emptyKey({ escape: true }), {
      panelHandled: false,
      editorFocus: true,
      dispatch,
    });
    expect(consumed).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores every key that is not Esc", () => {
    const dispatch = vi.fn();
    const consumed = handlePanelEscape(emptyKey({ tab: true }), {
      panelHandled: false,
      editorFocus: false,
      dispatch,
    });
    expect(consumed).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
