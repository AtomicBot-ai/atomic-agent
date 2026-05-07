import type { Key } from "ink";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { cycleNavSlot, type NavSlot } from "./section.js";
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
  // Tab / Shift+Tab cycles globally across nav slots (chat → Observe
  // tabs → Manage tabs → chat). Done here in the global handler — the
  // editor consumes Tab without inserting it, so a single dispatch
  // path avoids the double-jump that would otherwise happen if both
  // useInput hooks acted on the same key. The slash palette gets
  // priority so Tab there still accepts the completion.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    key.tab &&
    !state.pendingApproval
  ) {
    const direction: 1 | -1 = key.shift ? -1 : 1;
    const next = cycleNavSlot(state, direction);
    applyNavSlot(dispatch, next);
    return true;
  }
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
