import type { TuiState } from "../tui-state.js";
import { isUninstallAction, type UninstallAction } from "./uninstall-actions.js";
import {
  initialUninstallFlow,
  isUninstallConfirmed,
  type UninstallFlowState,
} from "./uninstall-state.js";

export function reduceUninstallAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isUninstallAction(action)) return null;
  const next = reduceFlow(state.uninstall, action);
  if (next === state.uninstall) return state;
  return { ...state, uninstall: next };
}

function reduceFlow(
  flow: UninstallFlowState | null,
  action: UninstallAction,
): UninstallFlowState | null {
  if (action.type === "uninstall_opened") return initialUninstallFlow();
  if (action.type === "uninstall_closed") return null;
  // Every other action is about a flow that is already open. A plan
  // that resolves after the operator cancelled must not reopen the
  // dialog behind them.
  if (flow === null) return null;

  switch (action.type) {
    case "uninstall_plan_loaded":
      if (flow.step !== "loading") return flow;
      return { ...flow, step: "review", preview: action.preview };
    case "uninstall_plan_failed":
      return { ...flow, step: "failed", errors: [action.error] };
    case "uninstall_cursor_set":
      if (flow.step !== "review") return flow;
      return { ...flow, cursor: action.cursor };
    case "uninstall_review_accepted":
      if (flow.step !== "review") return flow;
      // The typed word resets on every entry to the step, so backing out
      // and coming round again cannot arrive pre-armed.
      return { ...flow, step: "confirm", typed: "" };
    case "uninstall_typed_set":
      if (flow.step !== "confirm") return flow;
      return { ...flow, typed: action.typed };
    case "uninstall_started":
      // Guarded here rather than at the key layer so that no other
      // caller — a mouse click, a future automation — can start the
      // removal from a screen where the word was never typed.
      if (flow.step !== "confirm" || !isUninstallConfirmed(flow.typed)) {
        return flow;
      }
      return { ...flow, step: "closing" };
    default:
      return flow;
  }
}
