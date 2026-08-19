import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import {
  clampCloudShare,
  CLOUD_SHARE_COARSE_STEP,
  CLOUD_SHARE_STEP,
  RUN_MODES,
} from "./run-mode-nav.js";

export interface RunModePickerKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
}

/**
 * Keyboard layer for the run-mode dial overlay.
 *
 * Unlike the other panel key files this is called from `handleAppKey`
 * BEFORE the editor sees anything, next to the approval and update
 * prompts. That is deliberate: the overlay opens over the chat surface,
 * where the editor holds focus and would otherwise swallow `←`/`→` as
 * cursor motion and digits as literal text.
 *
 * While the picker is open EVERY key is consumed — same total-swallow
 * discipline as the Fallback pane's add-picker — so nothing leaks into
 * the editor, the nav cycle or the slash palette behind it.
 *
 *  - `↑`/`↓`, `j`/`k` — move between Local / Cloud / Fusion.
 *  - `←`/`→`          — dial ±5 (shift: ±25).
 *  - digits           — type a dial value directly.
 *  - `Enter`          — apply the highlighted mode + dial.
 *  - `Esc`            — close, reverting to what was in force.
 */
export function handleRunModePickerKey(
  input: string,
  key: Key,
  ctx: RunModePickerKeyContext,
): boolean {
  const picker = ctx.state.runModePanel.picker;
  if (!picker) return false;
  const { dispatch } = ctx;

  if (key.escape) {
    dispatch({ type: "run_mode_picker_closed" });
    return true;
  }
  if (key.return) {
    dispatch({
      type: "run_mode_change_requested",
      mode: picker.draftMode,
      cloudShare: picker.draftCloudShare,
    });
    dispatch({ type: "run_mode_picker_closed" });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({
      type: "run_mode_picker_cursor_set",
      cursor: picker.cursor - 1 < 0 ? RUN_MODES.length - 1 : picker.cursor - 1,
    });
    return true;
  }
  if (key.downArrow || input === "j") {
    dispatch({
      type: "run_mode_picker_cursor_set",
      cursor: picker.cursor + 1 >= RUN_MODES.length ? 0 : picker.cursor + 1,
    });
    return true;
  }
  if (key.leftArrow || key.rightArrow) {
    const step = key.shift ? CLOUD_SHARE_COARSE_STEP : CLOUD_SHARE_STEP;
    const delta = key.rightArrow ? step : -step;
    dispatch({
      type: "run_mode_picker_share_set",
      cloudShare: clampCloudShare(picker.draftCloudShare + delta),
    });
    return true;
  }
  if (input.length === 1 && input >= "0" && input <= "9") {
    dispatch({ type: "run_mode_picker_digit_typed", digit: input });
    return true;
  }
  if (key.backspace || key.delete) {
    dispatch({ type: "run_mode_picker_digits_cleared" });
    return true;
  }
  // Anything else is swallowed while the picker owns the keyboard.
  return true;
}
