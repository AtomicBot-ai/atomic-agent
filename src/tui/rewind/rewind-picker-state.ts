import type { TuiAction } from "../tui-action.js";
import type { RewindPickerState } from "../tui-state.js";
import { moveRewindChoice, readyRewindChoice, requestRewindChoice } from "./rewind-choice-state.js";

type RewindPickerAction = Extract<
  TuiAction,
  {
    type:
      | "rewind_picker_opened"
      | "rewind_picker_closed"
      | "rewind_picker_cursor_moved"
      | "rewind_picker_cursor_set"
      | "rewind_choice_requested"
      | "rewind_choice_ready";
  }
>;

/**
 * Open/close/cursor transitions of the `/rewind` picker (ATO-1057).
 * Pure: the orchestrator builds the list and does the cut. Opening with
 * no points leaves the picker closed (the orchestrator says why in the
 * chat instead of showing an empty box).
 *
 * After a point is picked the same box asks what to take back
 * (ATO-2467, `rewind-choice-state.ts`); the cursor keys and clicks then
 * move that highlight instead of the list's.
 */
export function reduceRewindPicker(
  picker: RewindPickerState | null,
  action: RewindPickerAction,
): RewindPickerState | null {
  switch (action.type) {
    case "rewind_picker_opened":
      return action.points.length > 0 ? { points: action.points, cursor: 0 } : null;
    case "rewind_picker_closed":
      return null;
    case "rewind_picker_cursor_moved":
      if (picker === null) return null;
      if (picker.choice) {
        return { ...picker, choice: moveRewindChoice(picker.choice, picker.choice.cursor + action.delta) };
      }
      return { ...picker, cursor: clampCursor(picker, picker.cursor + action.delta) };
    case "rewind_picker_cursor_set":
      if (picker === null) return null;
      if (picker.choice) return { ...picker, choice: moveRewindChoice(picker.choice, action.row) };
      return { ...picker, cursor: clampCursor(picker, action.row) };
    case "rewind_choice_requested":
      if (picker === null) return null;
      return { ...picker, choice: requestRewindChoice(action.point) };
    case "rewind_choice_ready":
      // Closed with Esc while the files were checked: stays closed.
      if (picker === null || !picker.choice) return picker;
      return { ...picker, choice: readyRewindChoice(picker.choice, action.turnIndex, action.facts) };
  }
}

function clampCursor(picker: RewindPickerState, row: number): number {
  const max = Math.max(0, picker.points.length - 1);
  return Math.min(max, Math.max(0, row));
}
