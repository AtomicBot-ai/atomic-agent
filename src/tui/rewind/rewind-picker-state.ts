import type { TuiAction } from "../tui-action.js";
import type { RewindPickerState } from "../tui-state.js";

type RewindPickerAction = Extract<
  TuiAction,
  {
    type:
      | "rewind_picker_opened"
      | "rewind_picker_closed"
      | "rewind_picker_cursor_moved"
      | "rewind_picker_cursor_set";
  }
>;

/**
 * Open/close/cursor transitions of the `/rewind` picker (ATO-1057).
 * Pure: the orchestrator builds the list and does the cut. Opening with
 * no points leaves the picker closed (the orchestrator says why in the
 * chat instead of showing an empty box).
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
      return { ...picker, cursor: clampCursor(picker, picker.cursor + action.delta) };
    case "rewind_picker_cursor_set":
      if (picker === null) return null;
      return { ...picker, cursor: clampCursor(picker, action.row) };
  }
}

function clampCursor(picker: RewindPickerState, row: number): number {
  const max = Math.max(0, picker.points.length - 1);
  return Math.min(max, Math.max(0, row));
}
