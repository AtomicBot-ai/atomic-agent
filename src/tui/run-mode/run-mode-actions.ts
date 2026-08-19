import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * Reducer actions for the Run-mode strip and its dial overlay. The
 * `run_mode_` prefix lets the root reducer narrow without a tag table.
 *
 * `run_mode_change_requested` is intentionally a REQUEST, not a state
 * change: only the orchestrator may write config or move the active
 * provider, and the mirror updates when it reports back via
 * `run_mode_synced`.
 */
export type RunModeAction =
  | {
      type: "run_mode_synced";
      effective: RunModeName;
      stored: RunModeName | null;
      cloudShare: number;
      localLabel: string | null;
      cloudLabel: string | null;
      cloudProviderMissing: boolean;
      localProviderMissing: boolean;
      degradedMessage: string | null;
    }
  | { type: "run_mode_change_requested"; mode: RunModeName; cloudShare?: number }
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
