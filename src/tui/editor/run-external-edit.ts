/**
 * The TUI side of `/edit` (ATO-655): pick what goes into the editor,
 * call the host, and put the result back in the composer.
 *
 * Only the host can hand the terminal over, so the editor itself runs
 * behind `onExternalEditorRequested`; this file decides the draft and
 * the notices, and is the part the slash handler calls.
 */
import type { TuiAction } from "../tui-action.js";
import type { ExternalEditResult } from "./external-editor.js";

export interface ExternalEditRequest {
  /** `/edit <text>`: start from this text instead of the draft. */
  readonly text?: string;
}

export interface ExternalEditHost {
  onExternalEditorRequested?(draft: string): ExternalEditResult;
}

export interface ExternalEditState {
  readonly inputValue: string;
  readonly status: string;
}

export const EDIT_BUSY_NOTICE =
  "the editor opens between turns: wait for the running turn to finish, or stop it first";
export const EDIT_UNAVAILABLE_NOTICE =
  "an external editor is not available in this session";
export const EDIT_NO_EDITOR_NOTICE =
  "no editor is set: export VISUAL or EDITOR (for example EDITOR=nano) and run /edit again";

/**
 * The editor blocks the whole process while it is open, so it is not
 * offered during a running turn: the turn would stall for as long as the
 * file stays open. Between turns nothing is waiting on the loop but
 * background polling, which catches up when the editor closes.
 */
export function runExternalEdit(
  request: ExternalEditRequest,
  state: ExternalEditState,
  dispatch: (action: TuiAction) => void,
  host: ExternalEditHost,
): void {
  // A buffer holding the command itself (`/edit` typed, `/ed` picked
  // from the palette) has done its job; anything else is the draft the
  // operator wants to keep writing.
  const holdsCommand = state.inputValue.trim().startsWith("/");
  const draft = request.text ?? (holdsCommand ? "" : state.inputValue);
  const notice = (text: string, warn = false): void => {
    dispatch({ type: "input_changed", value: draft });
    dispatch(warn ? { type: "system_message", text, variant: "warn" } : { type: "system_message", text });
  };
  if (state.status === "running") {
    notice(EDIT_BUSY_NOTICE);
    return;
  }
  if (!host.onExternalEditorRequested) {
    notice(EDIT_UNAVAILABLE_NOTICE);
    return;
  }
  const result = host.onExternalEditorRequested(draft);
  switch (result.kind) {
    case "edited":
      dispatch({ type: "input_changed", value: result.text });
      // Also what makes Ink paint a whole frame over the screen the
      // editor left behind: see `terminal-pause.ts`.
      dispatch({
        type: "system_message",
        text: `prompt loaded from ${result.editor}: review it, then press Enter to send`,
      });
      return;
    case "unchanged":
      notice(`closed ${result.editor}: the prompt is unchanged`);
      return;
    case "no-editor":
      notice(EDIT_NO_EDITOR_NOTICE, true);
      return;
    case "failed":
      notice(result.message, true);
      return;
  }
}
