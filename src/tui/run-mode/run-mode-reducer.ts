import type { TuiState } from "../tui-state.js";
import { isRunModeAction, type RunModeAction } from "./run-mode-actions.js";
import { clampCloudShare, RUN_MODES } from "./run-mode-nav.js";
import type { RunModePanelState } from "./run-mode-panel-state.js";

/**
 * Reducer slice for `state.runModePanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer falls through. Pure: config writes and provider swaps live in
 * `run-mode-orchestrator.ts`.
 */
export function reduceRunModeAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isRunModeAction(action)) return null;
  const panel = state.runModePanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, runModePanel: next };
}

function reducePanel(
  panel: RunModePanelState,
  action: RunModeAction,
): RunModePanelState {
  switch (action.type) {
    case "run_mode_synced":
      return {
        ...panel,
        effective: action.effective,
        stored: action.stored,
        cloudShare: action.cloudShare,
        localLabel: action.localLabel,
        cloudLabel: action.cloudLabel,
        localProviderId: action.localProviderId,
        cloudProviderId: action.cloudProviderId,
        cloudProviderMissing: action.cloudProviderMissing,
        localProviderMissing: action.localProviderMissing,
        degradedMessage: action.degradedMessage,
      };
    case "run_mode_change_started":
      return { ...panel, busy: true, lastError: null };
    case "run_mode_change_settled":
      return {
        ...panel,
        busy: false,
        lastError: action.error ?? null,
      };
    case "run_mode_picker_opened":
      return {
        ...panel,
        picker: {
          // Land on the mode currently in force so Enter alone is a no-op.
          cursor: Math.max(0, RUN_MODES.indexOf(panel.effective)),
          draftMode: panel.effective,
          draftCloudShare: panel.cloudShare,
          digitBuffer: "",
        },
      };
    case "run_mode_picker_closed":
      // Esc reverts by construction: the draft is discarded and the
      // committed mirror was never touched.
      return { ...panel, picker: null };
    case "run_mode_picker_cursor_set": {
      if (!panel.picker) return panel;
      const cursor = Math.max(
        0,
        Math.min(RUN_MODES.length - 1, action.cursor),
      );
      return {
        ...panel,
        picker: {
          ...panel.picker,
          cursor,
          draftMode: RUN_MODES[cursor] ?? panel.picker.draftMode,
          digitBuffer: "",
        },
      };
    }
    case "run_mode_picker_share_set": {
      if (!panel.picker) return panel;
      return {
        ...panel,
        picker: {
          ...panel.picker,
          draftCloudShare: clampCloudShare(action.cloudShare),
          digitBuffer: "",
        },
      };
    }
    case "run_mode_picker_digit_typed": {
      if (!panel.picker) return panel;
      // Cap at three digits so "100" is reachable but nothing longer is.
      const buffer = (panel.picker.digitBuffer + action.digit).slice(-3);
      const parsed = Number.parseInt(buffer, 10);
      return {
        ...panel,
        picker: {
          ...panel.picker,
          digitBuffer: buffer,
          draftCloudShare: Number.isNaN(parsed)
            ? panel.picker.draftCloudShare
            : clampCloudShare(parsed),
        },
      };
    }
    case "run_mode_picker_digits_cleared": {
      if (!panel.picker) return panel;
      return { ...panel, picker: { ...panel.picker, digitBuffer: "" } };
    }
  }
}
