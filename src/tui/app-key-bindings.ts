import type { Key } from "ink";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { cycleNavSlot, type NavSlot } from "./section.js";
import { selectSidebarTasks } from "./sidebar-tasks-selector.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

/**
 * Number of **terminal rows** a single PageUp / PageDown keypress
 * scrolls (chat scroll offset is line-based since the smooth-scroll
 * refactor). Approximates "⅓ viewport" — measured / clamped by
 * `ChatLog` against the real content height, so a slightly generous
 * value is harmless on short chats and feels right on long ones.
 */
const CHAT_PAGE_DELTA = 8;

export interface AppKeyCallbacks {
  onApprovalDecision(approvalId: string, approved: boolean): void;
  onAbort(): void;
  onQuit(): void;
  /** Optional — called when Enter is pressed on the focused sidebar row. */
  onSessionSwitchRequested?(sessionId: string): void;
  /**
   * Optional — called when Enter is pressed on a sidebar Tasks row.
   * The handler is expected to switch to the Tasks debug tab and open
   * the detail view for `taskId`.
   */
  onSidebarTaskActivated?(taskId: string): void;
}

export interface AppKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: AppKeyCallbacks;
  /** True if a prior Ctrl+C is still armed inside the double-press window. */
  ctrlCArmed: boolean;
  /** Called when this key press should arm (or disarm) the Ctrl+C quit. */
  setCtrlCArmed: (armed: boolean) => void;
  /**
   * Whether the sidebar is currently rendered (depends on terminal
   * width). Tab cycles `editor → sidebar(sessions) → sidebar(tasks)
   * → editor` only when this is `true` *and* the UI is in chat mode;
   * otherwise Tab falls through to the nav-slot cycle. Ctrl+B always
   * cycles nav slots forward regardless of sidebar visibility, so
   * power users have a single key to walk the dashboard even when
   * the sidebar steals plain Tab.
   */
  sidebarVisible: boolean;
}

/**
 * Global key-binding reducer executed outside the editor focus. Returns
 * `true` when the key was handled (the editor should ignore it). This
 * function is side-effectful (calls into `callbacks`) but the state
 * mutation funnels through `dispatch`, preserving reducer purity.
 */
export function handleAppKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks, ctrlCArmed, setCtrlCArmed } = ctx;
  if (state.pendingApproval) {
    return handleApprovalKey(input, key, state.pendingApproval, ctx);
  }
  if (
    ctx.sidebarVisible &&
    state.uiMode === "chat" &&
    state.chatFocus === "sidebar"
  ) {
    if (handleSidebarKey(input, key, ctx)) return true;
  }
  if (key.ctrl && input === "c") {
    if (ctrlCArmed) {
      callbacks.onAbort();
      callbacks.onQuit();
      dispatch({ type: "quit_requested" });
      return true;
    }
    setCtrlCArmed(true);
    if (state.status === "running" || state.status === "awaiting_approval") {
      callbacks.onAbort();
      dispatch({ type: "abort_requested" });
    }
    return true;
  }
  setCtrlCArmed(false);
  if (
    state.uiMode === "chat" &&
    !state.slashPaletteOpen &&
    !state.pendingApproval
  ) {
    if (key.pageUp) {
      dispatch({ type: "chat_scrolled", delta: CHAT_PAGE_DELTA });
      return true;
    }
    if (key.pageDown) {
      dispatch({ type: "chat_scrolled", delta: -CHAT_PAGE_DELTA });
      return true;
    }
  }
  const tasksTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "tasks" &&
    (state.tasksPanel.mode === "create" ||
      state.tasksPanel.cancelConfirm !== null ||
      state.tasksPanel.searchOpen);
  const skillsTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "skills" &&
    state.skillsPanel.mode === "detail";
  const localModelsTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "models" &&
    (state.localModelsPanel.mode === "backendUpdate" ||
      state.localModelsPanel.removeConfirmId !== null);
  // Telegram tab disables the editor outright (the panel owns letter
  // hotkeys), so on entry Tab/Shift+Tab still cycle. The "busy" flag
  // applies only when a modal is open and Tab/letters need to be
  // captured by the modal layer instead of cycling away from it.
  const telegramTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "telegram" &&
    state.telegramPanel.mode !== "list";
  const debugTabBusy =
    tasksTabBusy || skillsTabBusy || localModelsTabBusy || telegramTabBusy;
  // Ctrl+B is the dedicated nav-cycle escape valve: it always advances
  // one nav slot forward regardless of where focus currently is. This
  // is the key power users press when they want to reach Observe /
  // Manage without first clearing sidebar focus or re-pressing Tab to
  // walk through both sidebar panes.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    !state.pendingApproval &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    input === "b"
  ) {
    const next = cycleNavSlot(state, 1);
    applyNavSlot(dispatch, next);
    return true;
  }
  // Tab / Shift+Tab routing:
  //   - In chat mode with the sidebar visible, plain Tab cycles
  //     editor → sidebar(sessions) → sidebar(tasks) → editor so the
  //     operator can reach the rail with a single key. The
  //     in-sidebar transition (sessions ↔ tasks) is handled in
  //     `handleSidebarKey`; the path here covers the "land into the
  //     sidebar from the editor" leg.
  //   - Shift+Tab always cycles nav slots backward — same key surface
  //     as before so muscle memory survives.
  //   - Outside chat (debug mode) or with sidebar collapsed, plain
  //     Tab cycles nav slots forward as a fallback so power users on
  //     narrow terminals are not stranded.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    key.tab &&
    !state.pendingApproval
  ) {
    if (key.shift) {
      const prev = cycleNavSlot(state, -1);
      applyNavSlot(dispatch, prev);
      return true;
    }
    if (
      ctx.sidebarVisible &&
      state.uiMode === "chat" &&
      state.chatFocus === "editor"
    ) {
      // Land in the sidebar at the section the operator left last.
      dispatch({ type: "chat_focus_set", focus: "sidebar" });
      return true;
    }
    const next = cycleNavSlot(state, 1);
    applyNavSlot(dispatch, next);
    return true;
  }
  return false;
}

/**
 * Sidebar-focus key handler: navigates the active pane (Sessions or
 * Tasks), advances Tab through the panes, and dispatches the right
 * activation callback on Enter. Returns `true` when the key was
 * consumed so the global handler does not fall through to the
 * nav-cycle / editor pipeline.
 */
function handleSidebarKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (key.escape) {
    dispatch({ type: "chat_focus_set", focus: "editor" });
    return true;
  }
  // Tab cycles within the sidebar: sessions → tasks → editor (out).
  // Shift+Tab is left for the global handler so power users can step
  // back through the global nav slots from inside the rail too.
  if (key.tab && !key.shift) {
    if (state.sidebarSection === "sessions") {
      dispatch({ type: "sidebar_section_focused", section: "tasks" });
      return true;
    }
    // Already on Tasks → exit the rail and resume editor focus. Then
    // restore the section to "sessions" so the next Tab-in lands on
    // the same place the operator started.
    dispatch({ type: "chat_focus_set", focus: "editor" });
    dispatch({ type: "sidebar_section_focused", section: "sessions" });
    return true;
  }
  // Ctrl+B mirrors the VS Code gesture: drop sidebar focus back to
  // the editor without cycling through the second pane.
  if (key.ctrl && !key.shift && !key.meta && input === "b") {
    dispatch({ type: "chat_focus_set", focus: "editor" });
    return true;
  }
  if (key.upArrow) {
    if (state.sidebarSection === "tasks") {
      dispatch({ type: "sidebar_tasks_cursor_moved", delta: -1 });
    } else {
      dispatch({ type: "sidebar_cursor_moved", delta: -1 });
    }
    return true;
  }
  if (key.downArrow) {
    if (state.sidebarSection === "tasks") {
      dispatch({ type: "sidebar_tasks_cursor_moved", delta: 1 });
    } else {
      dispatch({ type: "sidebar_cursor_moved", delta: 1 });
    }
    return true;
  }
  if (key.return) {
    if (state.sidebarSection === "tasks") {
      const visible = selectSidebarTasks(state.tasksPanel.rows);
      const row = visible[state.sidebarTasksCursor] ?? visible[0];
      if (row && callbacks.onSidebarTaskActivated) {
        callbacks.onSidebarTaskActivated(row.id);
      }
      return true;
    }
    const entry = state.recentSessions[state.sidebarCursor];
    if (entry && callbacks.onSessionSwitchRequested) {
      callbacks.onSessionSwitchRequested(entry.sessionId);
    }
    return true;
  }
  // Swallow letter-keys while sidebar is focused so they do not bleed
  // into the editor through the global useInput hook.
  if (input.length > 0 && !key.ctrl && !key.meta) return true;
  return false;
}

function applyNavSlot(
  dispatch: (action: TuiAction) => void,
  slot: NavSlot,
): void {
  if (slot.kind === "run") {
    dispatch({ type: "ui_mode_set", mode: "chat" });
    return;
  }
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: slot.tab });
}

function handleApprovalKey(
  input: string,
  key: Key,
  request: ApprovalRequest,
  ctx: AppKeyContext,
): boolean {
  const lower = input.toLowerCase();
  if (lower === "y") {
    ctx.callbacks.onApprovalDecision(request.approvalId, true);
    ctx.dispatch({
      type: "approval_resolved",
      approvalId: request.approvalId,
      approved: true,
    });
    return true;
  }
  if (lower === "n") {
    ctx.callbacks.onApprovalDecision(request.approvalId, false);
    ctx.dispatch({
      type: "approval_resolved",
      approvalId: request.approvalId,
      approved: false,
    });
    return true;
  }
  if (key.escape || (key.ctrl && input === "c")) {
    ctx.callbacks.onApprovalDecision(request.approvalId, false);
    ctx.callbacks.onAbort();
    ctx.dispatch({
      type: "approval_resolved",
      approvalId: request.approvalId,
      approved: false,
    });
    ctx.dispatch({ type: "abort_requested" });
    return true;
  }
  return false;
}
