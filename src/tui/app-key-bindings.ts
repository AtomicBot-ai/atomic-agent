import type { Key } from "ink";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { cycleDebugTab } from "./components/debug-pane.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

export interface AppKeyCallbacks {
  onApprovalDecision(approvalId: string, approved: boolean): void;
  onAbort(): void;
  onQuit(): void;
}

export interface AppKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: AppKeyCallbacks;
  /** True if a prior Ctrl+C is still armed inside the double-press window. */
  ctrlCArmed: boolean;
  /** Called when this key press should arm (or disarm) the Ctrl+C quit. */
  setCtrlCArmed: (armed: boolean) => void;
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
  if (isF2(input)) {
    dispatch({ type: "ui_mode_toggled" });
    return true;
  }
  const tasksTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "tasks" &&
    (state.tasksPanel.mode === "create" ||
      state.tasksPanel.cancelConfirm !== null);
  if (!tasksTabBusy && state.uiMode === "debug" && key.tab && !key.shift) {
    dispatch({
      type: "tab_changed",
      tab: cycleDebugTab(state.activeTab, 1),
    });
    return true;
  }
  if (!tasksTabBusy && state.uiMode === "debug" && key.tab && key.shift) {
    dispatch({
      type: "tab_changed",
      tab: cycleDebugTab(state.activeTab, -1),
    });
    return true;
  }
  return false;
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

// Ink's `Key` type does not include function keys, so we match the raw
// escape sequences emitted for F2 by xterm, iTerm2 and Windows Terminal.
function isF2(input: string): boolean {
  return input === "\u001bOQ" || input === "\u001b[12~";
}
