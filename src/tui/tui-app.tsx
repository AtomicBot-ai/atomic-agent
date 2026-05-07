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
import { HotkeyHint } from "./components/hotkey-hint.js";
import { MultiLineEditor } from "./components/multi-line-editor.js";
import { SessionPicker } from "./components/session-picker.js";
import { SlashPalette } from "./components/slash-palette.js";
import { StatusBar } from "./components/status-bar.js";
import { TasksCancelModal } from "./components/tasks-cancel-modal.js";
import { filterSlashCommands } from "./commands/slash-commands.js";
import { slashPrefix } from "./commands/slash-command-parser.js";
import { handleEditorSubmit } from "./submit-handler.js";
import type { TaskCreateKind } from "./tasks/tasks-panel-state.js";
import type { TaskSchedule } from "../tasks/task-types.js";
import {
  canAcceptMessage,
  createInitialTuiState,
  DEFAULT_RING_BUFFER_SIZE,
  type InitialTuiLayoutOptions,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
import { handleLocalModelsTabKey } from "./local-models/local-models-key-bindings.js";
import { handleTasksTabKey } from "./tasks/tasks-key-bindings.js";
import { handleSkillsTabKey } from "./skills/skills-key-bindings.js";
import { handleTelegramTabKey } from "./telegram/telegram-key-bindings.js";

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
  /** Ask the orchestrator to dump the current user profile into the chat log. */
  onMemoryDumpRequested?(): void;
  /** Ask the orchestrator to print the skill catalog into the chat log (`/skills`). */
  onSkillCatalogRequested?(): void;
  /** Persist a new llama-server base URL after `/llama` (async health + disk write). */
  onPersistLlamaUrl?(url: string): void;
  /** Start the Tasks-tab auto-refresh loop (first entry only). */
  onTasksAutoRefreshStart?(): void;
  /** Perform a one-shot refresh of the tasks list. */
  onTasksRefreshRequested?(): void;
  /** Open the detail view for a task (re-seeds firings ring). */
  onTaskDetailRequested?(taskId: string): void;
  /** Switch the chat transcript to the task's session. */
  onTaskOpenSessionRequested?(taskId: string): void;
  /** Proceed with a task cancellation — the caller owns any confirm modal. */
  onTaskCancelConfirmed?(taskId: string): void;
  /** Execute one attempt of the task via `TaskRunner.runOne`. */
  onTaskRunNowRequested?(taskId: string): void;
  /** Managed llama.cpp panel: start 5s polling when the tab is active. */
  onLocalModelsAutoRefreshStart?(): void;
  /**
   * Pull weights for a model. `mode` selects the file set:
   * - `"with-mmproj"` (default for vision-capable rows) — GGUF + mmproj.
   * - `"gguf-only"` — GGUF only, even if vision-capable (`g` hotkey).
   * - `"mmproj-only"` — projector only, used when GGUF is already on
   *   disk and the operator wants to upgrade to vision support.
   */
  onLocalModelsPullRequested?(
    modelId: import("../local-llm/index.js").LocalModelId,
    mode?: "with-mmproj" | "gguf-only" | "mmproj-only",
  ): void;
  onLocalModelsSetActiveRequested?(modelId: import("../local-llm/index.js").LocalModelId): void;
  onLocalModelsBackendPullRequested?(): void;
  onLocalModelsRefreshRequested?(): void;
  onLocalModelsRemoveConfirmed?(modelId: import("../local-llm/index.js").LocalModelId): void;
  onLocalModelsStatusRequested?(): void | Promise<void>;
  /** Ask the orchestrator to (re)start the llama-server daemon. */
  onLocalModelsDaemonStartRequested?(): void | Promise<void>;
  /** Ask the orchestrator to stop the llama-server daemon. */
  onLocalModelsDaemonStopRequested?(): void | Promise<void>;
  /** Begin 1s tail polling of the llama-server log while the LLM logs tab is open. */
  onLocalLlmLogsAutoRefreshStart?(): void;
  /** Stop log-tail polling when the user navigates away from the logs tab. */
  onLocalLlmLogsAutoRefreshStop?(): void;
  /** Submit a new task from the create-form. */
  onTaskCreateSubmitted?(input: {
    schedule: TaskSchedule;
    message: string;
    kind: TaskCreateKind;
  }): void;
  /** Skills tab: start the 5s registry-listing refresh loop on first entry. */
  onSkillsAutoRefreshStart?(): void;
  /** Skills tab: one-shot refresh dispatched on `r` keypress. */
  onSkillsRefreshRequested?(): void;
  /** Skills tab: load the SKILL.md body and open the detail view. */
  onSkillDetailRequested?(name: string): void;
  /** Skills tab: flip the disabled bit and persist to `config.json`. */
  onSkillToggleRequested?(name: string): void;
  /** Slash-command surface: enable a skill explicitly (`/skill enable <name>`). */
  onSkillEnableRequested?(name: string): void;
  /** Slash-command surface: disable a skill explicitly (`/skill disable <name>`). */
  onSkillDisableRequested?(name: string): void;
  /**
   * Fired by `/dump`: asks the orchestrator to collect the current TUI
   * state + recent session traces into a zip under `~/Documents`. The
   * orchestrator owns the async work and reports progress through the
   * event bus.
   */
  onDebugBundleExportRequested?(state: TuiState): void;
  /** Telegram tab: refresh state mirror (token presence, owner, etc.). */
  onTelegramRefreshRequested?(): void;
  /**
   * Telegram tab: flip `enabled` from the current panel state. The
   * toggle uses `state.telegramPanel.enabled` as the source of truth;
   * use `onTelegramSetEnabledRequested` when the desired value is
   * known (e.g. slash command `/telegram enable`).
   */
  onTelegramToggleEnabledRequested?(): void | Promise<void>;
  /** Telegram tab: persist + reconcile to an explicit enabled value. */
  onTelegramSetEnabledRequested?(enabled: boolean): void | Promise<void>;
  /** Telegram tab: explicit restart (e.g. after backend hiccup). */
  onTelegramRestartRequested?(): void | Promise<void>;
  /** Telegram tab: open the masked token-entry modal. */
  onTelegramTokenPromptOpenRequested?(): void;
  /** Telegram tab: submit the token from the modal buffer. */
  onTelegramTokenSubmitted?(buffer: string): void | Promise<void>;
  /** Telegram tab: clear the persisted token (back to `down`). */
  onTelegramClearTokenRequested?(): void | Promise<void>;
  /** Telegram tab: arm a 60s pairing window that captures the next DM. */
  onTelegramStartPairingRequested?(): void | Promise<void>;
  /** Telegram tab: cancel an active pairing window. */
  onTelegramCancelPairingRequested?(): void;
  /** Telegram tab: dismiss the pairing-result modal. */
  onTelegramDismissPairingResultRequested?(): void;
  /** Telegram tab: clear `ownerUserId` (the operator wants to re-pair). */
  onTelegramClearOwnerRequested?(): void | Promise<void>;
  /**
   * Telegram tab: drive the setup flow forward by one step (the
   * primary Enter-key CTA). Reads from the live channel + config so
   * repeated presses cannot skip a step or trigger a duplicate
   * pairing window. See `TuiTelegramOrchestrator.advanceConnect`.
   */
  onTelegramAdvanceConnectRequested?(): void | Promise<void>;
  /** Telegram tab: toggle the inline advanced controls. */
  onTelegramAdvancedToggleRequested?(): void;
}

export interface TuiAppProps {
  session: TuiSessionInfo;
  bus: TuiEventBus;
  callbacks: TuiAppCallbacks;
  maxVisibleRows?: number;
  /** Optional initial debug tab / mode (e.g. after managed-mode wizard). */
  initialLayout?: InitialTuiLayoutOptions;
}

const DEFAULT_MAX_VISIBLE_ROWS = 14;
const CTRL_C_WINDOW_MS = 1500;

export function TuiApp({
  session,
  bus,
  callbacks,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  initialLayout,
}: TuiAppProps): ReactElement {
  const [state, dispatch] = useReducer(reduceTuiState, { session, initialLayout }, (init) =>
    createInitialTuiState(init.session, DEFAULT_RING_BUFFER_SIZE, init.initialLayout),
  );
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
    if (state.uiMode === "debug" && state.activeTab === "tasks") {
      callbacks.onTasksAutoRefreshStart?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (state.uiMode === "debug" && state.activeTab === "skills") {
      callbacks.onSkillsAutoRefreshStart?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (state.uiMode === "debug" && state.activeTab === "models") {
      callbacks.onLocalModelsAutoRefreshStart?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    const onLogsTab =
      state.uiMode === "debug" && state.activeTab === "llm-logs";
    if (onLogsTab) {
      callbacks.onLocalLlmLogsAutoRefreshStart?.();
      return () => callbacks.onLocalLlmLogsAutoRefreshStop?.();
    }
    return;
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (!ctrlCArmed) return;
    ctrlCTimer.current = setTimeout(() => setCtrlCArmed(false), CTRL_C_WINDOW_MS);
    return () => {
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    };
  }, [ctrlCArmed]);

  const tasksTabActive =
    state.uiMode === "debug" && state.activeTab === "tasks";
  const skillsTabActive =
    state.uiMode === "debug" && state.activeTab === "skills";
  const localModelsTabActive =
    state.uiMode === "debug" && state.activeTab === "models";
  const telegramTabActive =
    state.uiMode === "debug" && state.activeTab === "telegram";
  const editorFocus =
    !state.pendingApproval &&
    !tasksTabActive &&
    !skillsTabActive &&
    !telegramTabActive &&
    !(
      localModelsTabActive &&
      (state.localModelsPanel.pull !== null ||
        state.localModelsPanel.mode === "backendUpdate" ||
        state.localModelsPanel.removeConfirmId !== null)
    );

  useInput((input, key) => {
    const appHandled = handleAppKey(input, key, {
      state,
      dispatch,
      callbacks,
      ctrlCArmed,
      setCtrlCArmed,
    });
    if (appHandled) return;
    if (tasksTabActive) {
      handleTasksTabKey(input, key, { state, dispatch, callbacks });
      return;
    }
    if (skillsTabActive) {
      handleSkillsTabKey(input, key, { state, dispatch, callbacks });
      return;
    }
    if (localModelsTabActive) {
      handleLocalModelsTabKey(input, key, { state, dispatch, callbacks });
      return;
    }
    if (telegramTabActive) {
      handleTelegramTabKey(input, key, { state, dispatch, callbacks });
      return;
    }
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

  // Tab in the editor is reserved for slash-palette completion. Section
  // / sub-tab cycling lives entirely in `handleAppKey` so the same key
  // press cannot be acted on twice (once globally, once here through a
  // stale `state` closure). The editor still consumes Tab without
  // inserting a literal tab character — see `multi-line-editor.tsx`.
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
    <Box flexDirection="column" paddingLeft={2}>
      <StatusBar state={state} />
      {state.uiMode === "chat" ? (
        <ChatLog state={state} />
      ) : (
        <DebugPane state={state} maxVisible={maxVisibleRows} />
      )}
      {state.pendingApproval ? (
        <ApprovalModal request={state.pendingApproval} />
      ) : null}
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
      {state.tasksPanel.cancelConfirm ? (
        <TasksCancelModal confirm={state.tasksPanel.cancelConfirm} />
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

