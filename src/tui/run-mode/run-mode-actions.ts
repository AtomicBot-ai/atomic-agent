import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * Reducer actions for the Run-mode strip and its dial overlay. The
 * `run_mode_` prefix lets the root reducer narrow without a tag table.
 *
 * There is deliberately no "apply this mode" action here. Only the
 * orchestrator may write config or move the active provider, and it is
 * unreachable from a dispatch: the bus it listens on is bridged into
 * the reducer one way. Applying a mode goes through
 * `TuiAppCallbacks.onRunModeChangeRequested`; the mirror updates when
 * the orchestrator reports back via `run_mode_synced`.
 */
export type RunModeAction =
  | {
      type: "run_mode_synced";
      effective: RunModeName;
      stored: RunModeName | null;
      cloudShare: number;
      localLabel: string | null;
      cloudLabel: string | null;
      localProviderId: string | null;
      cloudProviderId: string | null;
      cloudProviderMissing: boolean;
      localProviderMissing: boolean;
      degradedMessage: string | null;
    }
  | { type: "run_mode_change_started" }
  | { type: "run_mode_change_settled"; error?: string }
  | { type: "run_mode_picker_opened" }
  | { type: "run_mode_picker_closed" }
  | { type: "run_mode_picker_cursor_set"; cursor: number }
  | { type: "run_mode_picker_share_set"; cloudShare: number }
  | { type: "run_mode_picker_digit_typed"; digit: string }
  | { type: "run_mode_picker_digits_cleared" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isRunModeAction(action: {
  type: string;
}): action is RunModeAction {
  return action.type.startsWith("run_mode_");
}
