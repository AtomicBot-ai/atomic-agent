import {
  dispatchSlashCommand,
  type SlashDispatchResult,
} from "./commands/slash-command-handler.js";
import {
  filterSlashCommands,
  resolveSlashCommand,
} from "./commands/slash-commands.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiAppCallbacks } from "./tui-app.js";
import { canAcceptMessage, type TuiState } from "./tui-state.js";

type Dispatch = (action: TuiAction) => void;

/**
 * Pure-ish submit pipeline: inspects the current TUI state and the
 * editor buffer, then either dispatches a reducer action, forwards a
 * message to the orchestrator, or runs a slash command. Kept out of
 * `tui-app.tsx` so the app shell stays under the 300-LOC budget and the
 * submit logic is unit-reachable.
 */
export function handleEditorSubmit(
  buffer: string,
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  if (state.sessionPickerOpen) {
    handleSessionPickerSubmit(state, dispatch, callbacks);
    return;
  }
  if (state.slashPaletteOpen) {
    const completions = filterSlashCommands(state.slashQuery);
    const chosen = completions[state.slashPaletteCursor];
    if (chosen) {
      runSlashCommand(`/${chosen.name}`, dispatch, callbacks);
      return;
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.length === 0) return;
  if (trimmed.startsWith("/")) {
    const resolved = resolveSlashCommand(
      trimmed.slice(1).split(/\s/)[0] ?? "",
    );
    if (resolved !== null || !canAcceptMessage(state)) {
      runSlashCommand(trimmed, dispatch, callbacks);
      return;
    }
  }
  if (!canAcceptMessage(state)) return;
  dispatch({ type: "message_submitted", message: trimmed });
  callbacks.onMessageSubmitted(trimmed);
}

function handleSessionPickerSubmit(
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  const entry = state.sessionPickerList[state.sessionPickerCursor];
  if (entry && callbacks.onSessionSwitchRequested) {
    callbacks.onSessionSwitchRequested(entry.sessionId);
  } else {
    dispatch({ type: "session_picker_closed" });
  }
  dispatch({ type: "input_changed", value: "" });
}

export function runSlashCommand(
  raw: string,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  const result: SlashDispatchResult = dispatchSlashCommand(raw);
  for (const action of result.actions) dispatch(action);
  if (result.systemMessage) {
    dispatch({ type: "runtime_info", line: result.systemMessage });
  }
  if (result.clearBuffer) dispatch({ type: "input_changed", value: "" });
  dispatch({ type: "slash_palette_closed" });
  if (result.triggerAbort) callbacks.onAbort();
  if (result.triggerQuit) {
    callbacks.onAbort();
    callbacks.onQuit();
  }
  if (result.triggerSessionPicker) callbacks.onSessionPickerRequested?.();
  if (result.triggerSessionNew) callbacks.onSessionNewRequested?.();
}
