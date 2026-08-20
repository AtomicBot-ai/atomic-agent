import { clampMenuCursor } from "./menu/menu-selectors.js";
import { filterSlashCommands } from "./commands/slash-commands.js";
import { selectSidebarTasks } from "./sidebar-tasks-selector.js";
import { THEME_NAMES } from "./theme/theme.js";
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
    case "theme_set":
      return { ...state, themeName: action.name };
    case "theme_picker_opened": {
      const idx = (THEME_NAMES as readonly string[]).indexOf(state.themeName);
      return {
        ...state,
        themePickerOpen: true,
        themePickerCursor: idx >= 0 ? idx : 0,
        themePickerOriginal: state.themeName,
      };
    }
    case "theme_picker_closed":
      return { ...state, themePickerOpen: false, themePickerOriginal: "" };
    case "theme_picker_cursor_moved": {
      if (!state.themePickerOpen) return state;
      const max = THEME_NAMES.length - 1;
      const next = Math.min(
        max,
        Math.max(0, state.themePickerCursor + action.delta),
      );
      return { ...state, themePickerCursor: next };
    }
    case "theme_picker_cursor_set": {
      if (!state.themePickerOpen) return state;
      const max = THEME_NAMES.length - 1;
      return {
        ...state,
        themePickerCursor: Math.min(max, Math.max(0, action.row)),
      };
    }
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
    case "menu_opened":
      // Always reopen at the root with an empty query: a menu that resumes
      // where it was last left makes the same keypress mean different
      // things on different days.
      return {
        ...state,
        menuOpen: true,
        menuPath: null,
        menuQuery: "",
        menuCursor: 0,
      };
    case "menu_closed":
      return {
        ...state,
        menuOpen: false,
        menuPath: null,
        menuQuery: "",
        menuCursor: 0,
      };
    case "menu_query_changed":
      // A query flattens the tree, so any open submenu is dropped with it.
      return { ...state, menuQuery: action.query, menuPath: null };
    case "menu_path_set":
      return { ...state, menuPath: action.path };
    case "menu_cursor_set":
      return { ...state, menuCursor: clampMenuCursor(state, action.cursor) };
    case "menu_cursor_moved":
      return {
        ...state,
        menuCursor: clampMenuCursor(state, state.menuCursor + action.delta),
      };
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
    case "message_queued":
      return {
        ...state,
        queuedMessages: [...state.queuedMessages, action.text],
        inputValue: "",
        inputHistoryCursor: null,
        // A queued submit is still a submit: the parked history draft
        // must not resurface on the next Down.
        inputHistoryDraft: null,
        slashPaletteOpen: false,
        slashQuery: "",
        slashPaletteCursor: 0,
      };
    case "queue_changed":
      return { ...state, queuedMessages: [...action.queued] };
    case "while_busy_mode_changed": {
      const next =
        action.mode ?? (state.whileBusyMode === "steer" ? "queue" : "steer");
      return { ...state, whileBusyMode: next };
    }
    case "message_steered":
      return {
        ...state,
        inputValue: "",
        inputHistoryCursor: null,
        // A steered submit is still a submit: the parked history draft
        // must not resurface on the next Down.
        inputHistoryDraft: null,
        slashPaletteOpen: false,
        slashQuery: "",
        slashPaletteCursor: 0,
      };
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
    case "session_picker_cursor_set": {
      const max = Math.max(0, state.sessionPickerList.length - 1);
      return {
        ...state,
        sessionPickerCursor: Math.min(max, Math.max(0, action.row)),
      };
    }
    case "llama_url_changed":
      return {
        ...state,
        session: { ...state.session, llamaUrl: action.url },
      };
    case "recent_sessions_updated": {
      const max = Math.max(0, action.sessions.length - 1);
      return {
        ...state,
        recentSessions: action.sessions,
        sidebarCursor: Math.min(state.sidebarCursor, max),
      };
    }
    case "chat_focus_toggled":
      return {
        ...state,
        chatFocus: state.chatFocus === "editor" ? "sidebar" : "editor",
      };
    case "chat_focus_set":
      return { ...state, chatFocus: action.focus };
    case "sidebar_section_focused":
      return { ...state, sidebarSection: action.section };
    case "sidebar_cursor_moved": {
      const max = Math.max(0, state.recentSessions.length - 1);
      const next = Math.min(
        max,
        Math.max(0, state.sidebarCursor + action.delta),
      );
      return { ...state, sidebarCursor: next };
    }
    case "sidebar_cursor_set": {
      const max = Math.max(0, state.recentSessions.length - 1);
      return {
        ...state,
        sidebarCursor: Math.min(max, Math.max(0, action.row)),
      };
    }
    case "sidebar_tasks_cursor_moved": {
      // Upper bound here is the **rendered** sidebar tasks list size,
      // capped by SIDEBAR_TASKS_LIMIT and the number of active/recurring
      // rows currently in `tasksPanel.rows`. We use the projected length
      // so the cursor can never point past the last visible row even if
      // the underlying `rows` array is much larger.
      const visible = selectSidebarTasks(state.tasksPanel.rows);
      const max = Math.max(0, visible.length - 1);
      const next = Math.min(
        max,
        Math.max(0, state.sidebarTasksCursor + action.delta),
      );
      return { ...state, sidebarTasksCursor: next };
    }
    case "sidebar_tasks_cursor_set": {
      const max = Math.max(0, selectSidebarTasks(state.tasksPanel.rows).length - 1);
      return {
        ...state,
        sidebarTasksCursor: Math.min(max, Math.max(0, action.row)),
      };
    }
    case "chat_scrolled": {
      // `chatScrollOffset` is in **lines** since the line-by-line
      // scroll refactor — the unit changed but the field name is
      // preserved for cross-cutting compat. Upper-clamping happens
      // visually in `ChatLog` (which knows the rendered content
      // height); the reducer only protects the lower bound. Letting
      // the value drift slightly past the on-screen max is fine —
      // the next PageDown / Esc snaps it back without surprise.
      const next = Math.max(0, state.chatScrollOffset + action.delta);
      return { ...state, chatScrollOffset: next };
    }
    case "chat_scroll_reset":
      return { ...state, chatScrollOffset: 0 };
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
        chatScrollOffset: 0,
        chatFocus: "editor",
        sidebarSection: "sessions",
        sidebarCursor: 0,
        sidebarTasksCursor: 0,
        queuedMessages: [],
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
    // Down on the live buffer has nowhere to go — leave the draft alone.
    if (delta === 1) return state;
    cursor = max;
  } else {
    const candidate = state.inputHistoryCursor + delta;
    if (candidate < 0) return state;
    if (candidate > max) cursor = null;
    else cursor = candidate;
  }
  // Entering recall parks the live draft; stepping back past the newest
  // entry hands it back verbatim instead of clearing the editor.
  const draft = state.inputHistoryCursor === null ? state.inputValue : state.inputHistoryDraft;
  const value = cursor === null ? (draft ?? "") : (history[cursor] ?? "");
  return {
    ...state,
    inputHistoryCursor: cursor,
    inputHistoryDraft: cursor === null ? null : draft,
    inputValue: value,
  };
}
