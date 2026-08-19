import { describe, it, expect, vi } from "vitest";
import type { Key } from "ink";

import {
  escapeHasNothingToCancel,
  escapeOpensMenu,
  handleAppKey,
  handlePanelEscape,
} from "./app-key-bindings.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
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

describe("handleAppKey — ctrl+n opens a new terminal window", () => {
  function ctx(
    state: ReturnType<typeof createInitialTuiState>,
    onNewWindowRequested: () => void,
  ) {
    return {
      state,
      dispatch: vi.fn(),
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
        onNewWindowRequested,
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
    };
  }

  it("fires the callback and claims the key in chat mode", () => {
    const onNewWindowRequested = vi.fn();
    const state = createInitialTuiState(stubSession());
    const handled = handleAppKey(
      "n",
      emptyKey({ ctrl: true }),
      ctx(state, onNewWindowRequested),
    );
    expect(handled).toBe(true);
    expect(onNewWindowRequested).toHaveBeenCalledTimes(1);
  });

  it("stays silent while an approval is pending", () => {
    // The approval layer owns every key — y/n/esc must not compete with
    // a window spawn.
    const onNewWindowRequested = vi.fn();
    const state = {
      ...createInitialTuiState(stubSession()),
      pendingApproval: pendingRequest(),
    };
    handleAppKey("n", emptyKey({ ctrl: true }), ctx(state, onNewWindowRequested));
    expect(onNewWindowRequested).not.toHaveBeenCalled();
  });

  it("stays silent while the slash palette is open", () => {
    const onNewWindowRequested = vi.fn();
    const state = {
      ...createInitialTuiState(stubSession()),
      slashPaletteOpen: true,
    };
    const handled = handleAppKey(
      "n",
      emptyKey({ ctrl: true }),
      ctx(state, onNewWindowRequested),
    );
    expect(handled).toBe(false);
    expect(onNewWindowRequested).not.toHaveBeenCalled();
  });

  it("ignores a plain `n` and shift/meta variants", () => {
    const onNewWindowRequested = vi.fn();
    const state = createInitialTuiState(stubSession());
    handleAppKey("n", emptyKey(), ctx(state, onNewWindowRequested));
    handleAppKey(
      "n",
      emptyKey({ ctrl: true, shift: true }),
      ctx(state, onNewWindowRequested),
    );
    handleAppKey(
      "n",
      emptyKey({ ctrl: true, meta: true }),
      ctx(state, onNewWindowRequested),
    );
    expect(onNewWindowRequested).not.toHaveBeenCalled();
  });

  it("does not throw when no handler is wired", () => {
    const state = createInitialTuiState(stubSession());
    const handled = handleAppKey("n", emptyKey({ ctrl: true }), {
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
    expect(handled).toBe(true);
  });
});

describe("Ctrl+T — Enter-while-busy mode", () => {
  function ctx(state: ReturnType<typeof createInitialTuiState>, extra = {}) {
    return {
      state,
      dispatch: vi.fn(),
      callbacks: {
        onApprovalDecision: vi.fn(),
        onAbort: vi.fn(),
        onQuit: vi.fn(),
        onWhileBusyModePersistRequested: vi.fn(),
      },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
      ...extra,
    };
  }

  it("toggles the mode and asks for it to be persisted", () => {
    const state = createInitialTuiState(stubSession());
    expect(state.whileBusyMode).toBe("steer");
    const c = ctx(state);
    const handled = handleAppKey("t", emptyKey({ ctrl: true }), c);
    expect(handled).toBe(true);
    expect(c.dispatch).toHaveBeenCalledWith({
      type: "while_busy_mode_changed",
    });
    expect(c.callbacks.onWhileBusyModePersistRequested).toHaveBeenCalledWith(
      "queue",
    );
  });

  it("persists the opposite direction from queue mode", () => {
    const state = { ...createInitialTuiState(stubSession()), whileBusyMode: "queue" as const };
    const c = ctx(state);
    handleAppKey("t", emptyKey({ ctrl: true }), c);
    expect(c.callbacks.onWhileBusyModePersistRequested).toHaveBeenCalledWith(
      "steer",
    );
  });

  it("leaves a pending approval alone — y/n/esc own the keyboard there", () => {
    const state = {
      ...createInitialTuiState(stubSession()),
      pendingApproval: pendingRequest(),
    };
    const c = ctx(state);
    const handled = handleAppKey("t", emptyKey({ ctrl: true }), c);
    expect(handled).toBe(false);
    expect(c.dispatch).not.toHaveBeenCalledWith({
      type: "while_busy_mode_changed",
    });
  });

  it("ignores a plain t", () => {
    const c = ctx(createInitialTuiState(stubSession()));
    handleAppKey("t", emptyKey(), c);
    expect(c.dispatch).not.toHaveBeenCalledWith({
      type: "while_busy_mode_changed",
    });
  });
});

/**
 * The Esc ladder, rung by rung. Each case is a state in which the
 * operator pressing Esc means something specific and *not* "show me the
 * menu" — the whole risk of giving the key a new meaning is that one of
 * these quietly loses it.
 */
describe("escapeOpensMenu", () => {
  function runScreen(patch: Partial<TuiState> = {}): TuiState {
    return { ...createInitialTuiState(stubSession()), uiMode: "chat", ...patch };
  }

  it("opens on an idle, empty, unscrolled Run screen", () => {
    expect(escapeOpensMenu(runScreen())).toBe(true);
  });

  it("declines while the menu is already up, so Esc cannot toggle it", () => {
    expect(escapeOpensMenu(runScreen({ menuOpen: true }))).toBe(false);
    // ...but the surface underneath is still an idle Run screen, which is
    // what the hint strip reads and why the two predicates are separate.
    expect(escapeHasNothingToCancel(runScreen({ menuOpen: true }))).toBe(true);
  });

  it("declines with a draft in the buffer — Esc clears it first", () => {
    expect(escapeOpensMenu(runScreen({ inputValue: "half a thought" }))).toBe(
      false,
    );
  });

  it("declines while a turn is running — Esc is the abort", () => {
    expect(escapeOpensMenu(runScreen({ status: "running" }))).toBe(false);
  });

  it("declines while the transcript is scrolled back — Esc snaps it down", () => {
    expect(escapeOpensMenu(runScreen({ chatScrollOffset: 4 }))).toBe(false);
  });

  it("declines under every overlay that owns Esc in its own layer", () => {
    const overlays: Partial<TuiState>[] = [
      { slashPaletteOpen: true },
      { sessionPickerOpen: true },
      { themePickerOpen: true },
      { pendingApproval: pendingRequest() },
      { updatePrompt: { current: "0.3.0", latest: "0.4.0" } },
      { updateStatus: "done" },
    ];
    for (const overlay of overlays) {
      expect(escapeOpensMenu(runScreen(overlay))).toBe(false);
    }
  });

  it("declines while the run-mode dial is up", () => {
    const base = createInitialTuiState(stubSession());
    const state = runScreen({
      runModePanel: {
        ...base.runModePanel,
        picker: {
          cursor: 0,
          draftMode: "local",
          draftCloudShare: 0,
          digitBuffer: "",
        },
      },
    });
    expect(escapeOpensMenu(state)).toBe(false);
  });

  it("declines with the sidebar focused — Esc hands focus back first", () => {
    expect(escapeOpensMenu(runScreen({ chatFocus: "sidebar" }))).toBe(false);
  });

  it("declines inside a debug panel — Esc is the way home to Run", () => {
    expect(escapeOpensMenu(runScreen({ uiMode: "debug" }))).toBe(false);
  });
});
