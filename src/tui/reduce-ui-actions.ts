import { filterSlashCommands } from "./commands/slash-commands.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";

/**
 * Reducer slice that folds UI/editor-level actions (ui mode, tool
 * expand, slash palette, input history, chat transcript wipe). Split
 * out of `agent-event-reducer.ts` to keep that file under the 300-LOC
 * budget without churning action types.
 *
 * Returns `null` when the action is not handled here so the caller can
 * continue its own switch statement.
 */
export function reduceUiAction(
  state: TuiState,
  action: TuiAction,
): TuiState | null {
  switch (action.type) {
    case "ui_mode_toggled":
      return { ...state, uiMode: state.uiMode === "chat" ? "debug" : "chat" };
    case "ui_mode_set":
      return { ...state, uiMode: action.mode };
    case "tool_expand_toggled": {
      const current = state.toolsExpandedById[action.toolCardId] ?? false;
      return {
        ...state,
        toolsExpandedById: {
          ...state.toolsExpandedById,
          [action.toolCardId]: !current,
        },
      };
    }
    case "tool_expand_all_set": {
      const next: Record<string, boolean> = {};
      for (const msg of state.messages) {
        for (const card of msg.toolCards ?? []) next[card.id] = action.expanded;
      }
      for (const card of state.streamingToolCards) next[card.id] = action.expanded;
      return { ...state, toolsExpandedById: next };
    }
    case "slash_palette_opened":
      return {
        ...state,
        slashPaletteOpen: true,
        slashQuery: action.query,
        slashPaletteCursor: 0,
      };
    case "slash_palette_queried":
      return { ...state, slashQuery: action.query, slashPaletteCursor: 0 };
    case "slash_palette_closed":
      return {
        ...state,
        slashPaletteOpen: false,
        slashQuery: "",
        slashPaletteCursor: 0,
      };
    case "slash_palette_cursor_moved": {
      const max = Math.max(0, filterSlashCommands(state.slashQuery).length - 1);
      const next = Math.min(
        max,
        Math.max(0, state.slashPaletteCursor + action.delta),
      );
      return { ...state, slashPaletteCursor: next };
    }
    case "slash_palette_cursor_set": {
      const max = Math.max(0, filterSlashCommands(state.slashQuery).length - 1);
      return { ...state, slashPaletteCursor: Math.min(max, Math.max(0, action.row)) };
    }
    case "input_history_navigated":
      return navigateInputHistory(state, action.delta);
    case "input_history_reset":
      return { ...state, inputHistoryCursor: null };
    case "chat_cleared":
      return {
        ...state,
        messages: [],
        reasoning: [],
        feed: [],
        streamingAssistantText: null,
        streamingToolCalls: [],
        streamingToolCards: [],
        toolsExpandedById: {},
        lastRunStatus: null,
      };
    case "session_picker_opened":
      return {
        ...state,
        sessionPickerOpen: true,
        sessionPickerList: action.sessions,
        sessionPickerCursor: 0,
      };
    case "session_picker_closed":
      return { ...state, sessionPickerOpen: false };
    case "session_picker_cursor_moved": {
      const max = Math.max(0, state.sessionPickerList.length - 1);
      const next = Math.min(
        max,
        Math.max(0, state.sessionPickerCursor + action.delta),
      );
      return { ...state, sessionPickerCursor: next };
    }
    case "llama_url_changed":
      return {
        ...state,
        session: { ...state.session, llamaUrl: action.url },
      };
    case "session_switched":
      return {
        ...state,
        session: {
          ...state.session,
          sessionId: action.sessionId,
          workingDir: action.workingDir,
        },
        messages: [...action.messages],
        reasoning: [],
        feed: [],
        logs: [],
        streamingAssistantText: null,
        streamingToolCalls: [],
        streamingToolCards: [],
        toolsExpandedById: {},
        currentTurnToolSteps: 0,
        currentStep: 0,
        stepStartedAt: null,
        runStartedAt: null,
        pendingApproval: null,
        lastRunStatus: null,
        runHistory: [],
        sessionPickerOpen: false,
        sessionPickerCursor: 0,
      };
    default:
      return null;
  }
}

function navigateInputHistory(state: TuiState, delta: 1 | -1): TuiState {
  const history = state.inputHistory;
  if (history.length === 0) return state;
  const max = history.length - 1;
  // delta = -1 moves to older entries (Up), delta = +1 towards the live
  // buffer (Down). Cursor value equals the history index shown.
  let cursor: number | null;
  if (state.inputHistoryCursor === null) {
    cursor = delta === -1 ? max : null;
  } else {
    const candidate = state.inputHistoryCursor + delta;
    if (candidate < 0) return state;
    if (candidate > max) cursor = null;
    else cursor = candidate;
  }
  const value = cursor === null ? "" : (history[cursor] ?? "");
  return { ...state, inputHistoryCursor: cursor, inputValue: value };
}
