import {
  dispatchSlashCommand,
  type SlashDispatchResult,
} from "./commands/slash-command-handler.js";
import { parseSlashCommand, slashPrefix } from "./commands/slash-command-parser.js";
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

  const trimmed = buffer.trim();
  if (trimmed.length === 0) return;

  /**
   * 1) `/name` or `/name args` for a **registered** command: run from the
   *    live buffer first, independent of palette state (avoids stale
   *    `slashQuery` / wrong highlight on Enter).
   * 2) Unknown `/token`: show an error, never treat as a user message.
   * 3) Palette: partial input (`/h`, or `/` only) uses the highlight.
   * 4) A lone `/` with no palette is a no-op (never send to the model).
   */
  if (trimmed.startsWith("/")) {
    const parsed = parseSlashCommand(trimmed);
    if (parsed !== null) {
      const resolved = resolveSlashCommand(parsed.name);
      if (resolved !== null) {
        runSlashCommand(trimmed, dispatch, callbacks);
        return;
      }
      if (parsed.name.length > 0) {
        runSlashCommand(trimmed, dispatch, callbacks);
        return;
      }
    }
  }

  if (state.slashPaletteOpen) {
    const query = slashPrefix(trimmed) ?? "";
    const completions = filterSlashCommands(query);
    const maxRow = Math.max(0, completions.length - 1);
    const safeCursor = Math.min(state.slashPaletteCursor, maxRow);
    const chosen = completions[safeCursor];
    if (chosen) {
      runSlashCommand(`/${chosen.name}`, dispatch, callbacks);
      return;
    }
  }

  if (trimmed.startsWith("/")) {
    return;
  }

  if (!canAcceptMessage(state)) return;
  dispatch({ type: "message_submitted" });
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
    dispatch({ type: "system_message", text: result.systemMessage });
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
  if (result.triggerMemoryDump) callbacks.onMemoryDumpRequested?.();
  if (result.triggerSkillCatalogDump) callbacks.onSkillCatalogRequested?.();
  if (result.persistLlamaUrl) {
    callbacks.onPersistLlamaUrl?.(result.persistLlamaUrl);
  }
  if (result.taskCancelId) callbacks.onTaskCancelConfirmed?.(result.taskCancelId);
  if (result.taskRunId) callbacks.onTaskRunNowRequested?.(result.taskRunId);
}
