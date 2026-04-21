import { Box, useApp, useInput } from "ink";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { reduceTuiState } from "./agent-event-reducer.js";
import type { TuiAction } from "./tui-action.js";
import { handleAppKey } from "./app-key-bindings.js";
import { ApprovalModal } from "./approval-modal.js";
import { ChatLog } from "./components/chat-log.js";
import { DebugPane } from "./components/debug-pane.js";
import { FooterLine } from "./components/footer-line.js";
import { HeaderLine } from "./components/header-line.js";
import { HotkeyHint } from "./components/hotkey-hint.js";
import { MultiLineEditor } from "./components/multi-line-editor.js";
import { SessionPicker } from "./components/session-picker.js";
import { SlashPalette } from "./components/slash-palette.js";
import { StatusLine } from "./components/status-line.js";
import { filterSlashCommands } from "./commands/slash-commands.js";
import { slashPrefix } from "./commands/slash-command-parser.js";
import { handleEditorSubmit } from "./submit-handler.js";
import {
  canAcceptMessage,
  createInitialTuiState,
  type TuiSessionInfo,
} from "./tui-state.js";

export { makeTuiEventBus } from "./make-event-bus.js";

export interface TuiEventBus {
  subscribe(listener: (action: TuiAction) => void): () => void;
}

export interface TuiAppCallbacks {
  onApprovalDecision(approvalId: string, approved: boolean): void;
  onAbort(): void;
  onQuit(): void;
  onMessageSubmitted(message: string): void;
  /** Ask the orchestrator to emit the recent-sessions list to the bus. */
  onSessionPickerRequested?(): void;
  /** Ask the orchestrator to swap to an existing persisted session. */
  onSessionSwitchRequested?(sessionId: string): void;
  /** Ask the orchestrator to start a fresh session. */
  onSessionNewRequested?(): void;
  /** Persist a new llama-server base URL after `/llama` (async health + disk write). */
  onPersistLlamaUrl?(url: string): void;
}

export interface TuiAppProps {
  session: TuiSessionInfo;
  bus: TuiEventBus;
  callbacks: TuiAppCallbacks;
  maxVisibleRows?: number;
}

const DEFAULT_MAX_VISIBLE_ROWS = 14;
const CTRL_C_WINDOW_MS = 1500;

export function TuiApp({
  session,
  bus,
  callbacks,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
}: TuiAppProps): ReactElement {
  const [state, dispatch] = useReducer(reduceTuiState, session, createInitialTuiState);
  const app = useApp();
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => bus.subscribe(dispatch), [bus]);

  useEffect(() => {
    if (state.status === "quitting") {
      callbacks.onQuit();
      app.exit();
    }
  }, [state.status, callbacks, app]);

  useEffect(() => {
    if (!ctrlCArmed) return;
    ctrlCTimer.current = setTimeout(() => setCtrlCArmed(false), CTRL_C_WINDOW_MS);
    return () => {
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    };
  }, [ctrlCArmed]);

  const editorFocus = !state.pendingApproval;

  useInput((input, key) => {
    handleAppKey(input, key, {
      state,
      dispatch,
      callbacks,
      ctrlCArmed,
      setCtrlCArmed,
    });
  });

  const submit = useCallback(
    (buffer: string) => handleEditorSubmit(buffer, state, dispatch, callbacks),
    [state, callbacks],
  );

  const onEditorChange = useCallback(
    (next: string) => {
      dispatch({ type: "input_changed", value: next });
      const prefix = slashPrefix(next);
      if (prefix !== null) {
        dispatch({ type: "slash_palette_opened", query: prefix });
      } else if (state.slashPaletteOpen) {
        dispatch({ type: "slash_palette_closed" });
      }
    },
    [state.slashPaletteOpen],
  );

  const onEscape = useCallback(() => {
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_closed" });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_closed" });
      return;
    }
    if (state.pendingApproval) return;
    if (canAcceptMessage(state)) {
      callbacks.onQuit();
      dispatch({ type: "quit_requested" });
    } else {
      callbacks.onAbort();
      dispatch({ type: "abort_requested" });
    }
  }, [state, callbacks]);

  const onTab = useCallback(() => {
    if (!state.slashPaletteOpen) return;
    const completions = filterSlashCommands(state.slashQuery);
    const chosen = completions[state.slashPaletteCursor];
    if (!chosen) return;
    dispatch({ type: "input_changed", value: `/${chosen.name} ` });
    dispatch({ type: "slash_palette_closed" });
  }, [state.slashPaletteOpen, state.slashQuery, state.slashPaletteCursor]);

  const onHistoryPrev = useCallback(() => {
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_cursor_moved", delta: -1 });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_cursor_moved", delta: -1 });
      return;
    }
    dispatch({ type: "input_history_navigated", delta: -1 });
  }, [state.slashPaletteOpen, state.sessionPickerOpen]);

  const onHistoryNext = useCallback(() => {
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_cursor_moved", delta: 1 });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_cursor_moved", delta: 1 });
      return;
    }
    dispatch({ type: "input_history_navigated", delta: 1 });
  }, [state.slashPaletteOpen, state.sessionPickerOpen]);

  return (
    <Box flexDirection="column">
      <HeaderLine state={state} />
      {state.uiMode === "chat" ? (
        <ChatLog state={state} />
      ) : (
        <DebugPane state={state} maxVisible={maxVisibleRows} />
      )}
      {state.pendingApproval ? (
        <ApprovalModal request={state.pendingApproval} />
      ) : null}
      <StatusLine state={state} />
      <FooterLine state={state} />
      {state.sessionPickerOpen ? (
        <SessionPicker
          sessions={state.sessionPickerList}
          cursor={state.sessionPickerCursor}
          currentSessionId={state.session.sessionId}
        />
      ) : null}
      {state.slashPaletteOpen ? (
        <SlashPalette
          query={state.slashQuery}
          cursor={state.slashPaletteCursor}
        />
      ) : null}
      <MultiLineEditor
        value={state.inputValue}
        placeholder="Type a message or `/` for commands…"
        focus={editorFocus}
        disabled={!canAcceptMessage(state)}
        onChange={onEditorChange}
        onSubmit={submit}
        onEscape={onEscape}
        onTab={onTab}
        onHistoryPrev={onHistoryPrev}
        onHistoryNext={onHistoryNext}
      />
      <HotkeyHint state={state} ctrlCArmed={ctrlCArmed} />
    </Box>
  );
}

