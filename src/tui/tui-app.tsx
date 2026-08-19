import { Box, Text, useApp, useInput, type DOMElement, type Key } from "ink";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { reduceTuiState } from "./agent-event-reducer.js";
import type { ApprovalGrantScope } from "../approval/approval-gate.js";
import type { WhileBusySubmitMode } from "../config/index.js";
import type { TuiAction } from "./tui-action.js";
import {
  handleAppKey,
  handlePanelEscape,
  isPanelModalOpen,
} from "./app-key-bindings.js";
import { ApprovalModal } from "./approval-modal.js";
import { ChatLog } from "./components/chat-log.js";
import { DebugPane } from "./components/debug-pane.js";
import { HotkeyHint } from "./components/hotkey-hint.js";
import { LlmHealthBadge } from "./components/llm-health-badge.js";
import { PromptShell } from "./components/prompt-shell.js";
import { QueuedMessages } from "./components/queued-messages.js";
import { SessionPicker } from "./components/session-picker.js";
import { ThemePicker } from "./components/theme-picker.js";
import {
  isThemeName,
  setActiveTheme,
  theme,
  THEME_NAMES,
  THEMES,
} from "./theme/theme.js";
import { Sidebar } from "./components/sidebar.js";
import { selectSidebarTasks } from "./sidebar-tasks-selector.js";
import { SlashPalette } from "./components/slash-palette.js";
import { StatusBar } from "./components/status-bar.js";
import { RunModeBar } from "./components/run-mode-bar.js";
import { RunModePicker } from "./components/run-mode-picker.js";
import type { RunModeName } from "../config/index.js";
import { TasksCancelModal } from "./components/tasks-cancel-modal.js";
import { UpdateModal } from "./components/update-modal.js";
import { UpdateIndicator } from "./components/update-indicator.js";
import { UpdateRestartPrompt } from "./components/update-restart-prompt.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import {
  computeSidebarRowBudget,
  computeSidebarWidth,
  isSidebarVisible,
} from "./layout.js";
import { filterSlashCommands } from "./commands/slash-commands.js";
import { slashPrefix } from "./commands/slash-command-parser.js";
import { handleEditorSubmit } from "./submit-handler.js";
import type { TaskCreateKind } from "./tasks/tasks-panel-state.js";
import type { TaskSchedule } from "../tasks/task-types.js";
import {
  canAcceptMessage,
  canTypeMessage,
  createInitialTuiState,
  DEFAULT_RING_BUFFER_SIZE,
  type InitialTuiLayoutOptions,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
import { handleLocalModelsTabKey } from "./local-models/local-models-key-bindings.js";
import { handleLlmPanelKey } from "./llm-panel/llm-panel-key-bindings.js";
import { selectPromptLlmMeta } from "./llm-panel/llm-panel-selectors.js";
import { handleTasksTabKey } from "./tasks/tasks-key-bindings.js";
import { handleSkillsTabKey } from "./skills/skills-key-bindings.js";
import type { SkillSourceKind } from "../skills/index.js";
import type { HubSkillRow } from "./skills/skills-panel-state.js";
import { handleMemoryTabKey } from "./memory/memory-key-bindings.js";
import type { MemorySummaryRow } from "./memory/memory-panel-state.js";
import { handleMcpTabKey } from "./mcp/mcp-key-bindings.js";
import { handleImportTabKey } from "./import/import-key-bindings.js";
import type { ImportFormState } from "./import/import-panel-state.js";
import { handleProvidersTabKey } from "./providers/providers-key-bindings.js";
import { handleTelegramTabKey } from "./telegram/telegram-key-bindings.js";
import { handlePrivacyTabKey } from "./privacy/privacy-key-bindings.js";
import { MouseProvider } from "./mouse/mouse-context.js";
import {
  MOUSE_LAYER_BASE,
  MOUSE_LAYER_MODAL,
  MouseTargetRegistry,
  type MouseHit,
} from "./mouse/mouse-registry.js";
import type { MouseSource } from "./mouse/mouse-source.js";
import { arrowKey } from "./mouse/synthetic-key.js";

export { makeTuiEventBus } from "./make-event-bus.js";

export interface TuiEventBus {
  subscribe(listener: (action: TuiAction) => void): () => void;
}

export interface TuiAppCallbacks {
  onApprovalDecision(
    approvalId: string,
    approved: boolean,
    grant?: ApprovalGrantScope,
  ): void;
  onAbort(): void;
  onQuit(): void;
  onMessageSubmitted(message: string): void;
  /** Drop every message parked behind the running turn (`/queue clear`). */
  onQueueClearRequested?(): void;
  /**
   * Fold a message into the turn already running (`steer` mode). The
   * orchestrator falls back to the queue when the runtime refuses —
   * the turn may have ended between the keypress and the dispatch.
   */
  onMessageSteered?(message: string): void;
  /** Persist the Enter-while-busy mode after a Ctrl+T flip. */
  onWhileBusyModePersistRequested?(mode: WhileBusySubmitMode): void;
  /** Persist a run-mode switch and hot-apply the provider swap. */
  onRunModeChangeRequested?(mode: RunModeName, cloudShare?: number): void;
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
  /** Persist the chosen TUI theme name into the user config (`/theme`). */
  onThemePersistRequested?(themeName: string): void;
  /**
   * `/mouse on|off` — flip terminal mouse reporting live. `null` asks
   * for the current state to be reported without changing it. The
   * handler owns the escape sequences and the config write.
   */
  onMouseSupportRequested?(enabled: boolean | null): void;
  /** Start the Tasks-tab auto-refresh loop (first entry only). */
  onTasksAutoRefreshStart?(): void;
  /** Perform a one-shot refresh of the tasks list. */
  onTasksRefreshRequested?(): void;
  /** Open the detail view for a task (re-seeds firings ring). */
  onTaskDetailRequested?(taskId: string): void;
  /**
   * Sidebar Tasks pane: Enter pressed on the row for `taskId`. The
   * handler is expected to switch to the Tasks debug tab and open the
   * detail view, mirroring what the operator would do manually.
   */
  onSidebarTaskActivated?(taskId: string): void;
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
  /** Cycle the managed daemon's GPU preference (auto → devices → cpu). */
  onLocalModelsDeviceCycleRequested?(): void | Promise<void>;
  onLocalModelsRemoveConfirmed?(modelId: import("../local-llm/index.js").LocalModelId): void;
  onLocalModelsStatusRequested?(): void | Promise<void>;
  /** Ask the orchestrator to (re)start the llama-server daemon. */
  onLocalModelsDaemonStartRequested?(): void | Promise<void>;
  /** Ask the orchestrator to stop the llama-server daemon. */
  onLocalModelsDaemonStopRequested?(): void | Promise<void>;
  /**
   * Memory-v2 phase 1B. Pull an embedding model's GGUF, then mark it as
   * the active embedding model. Does not (re)start the embedding
   * daemon — the operator chains an explicit `s` for that.
   */
  onLocalModelsEmbeddingPullRequested?(
    modelId: import("../local-llm/index.js").EmbeddingModelId,
  ): void;
  /** Memory-v2 phase 1B. Persist the embedding model selection. */
  onLocalModelsEmbeddingSetActiveRequested?(
    modelId: import("../local-llm/index.js").EmbeddingModelId,
  ): void;
  /** Memory-v2 phase 1B. Toggle `localModels.embeddings.enabled`. */
  onLocalModelsEmbeddingToggleEnabledRequested?(): void;
  /** Memory-v2 phase 1B. Disable local embedding daemon without toggling it on. */
  onLocalModelsEmbeddingDisableRequested?(): void;
  /**
   * Memory-v2 phase 1B. Start or hot-swap the embedding daemon for the
   * active `*` row (chat daemon must already be running).
   */
  onLocalModelsEmbeddingStartRequested?(): void;
  /** Memory-v2 phase 1B. Delete an embedding model's GGUF. */
  onLocalModelsEmbeddingRemoveConfirmed?(
    modelId: import("../local-llm/index.js").EmbeddingModelId,
  ): void;
  /**
   * Memory-v2 phase 1B onboarding. Resolution of the post-chat-pull
   * yes/no modal that offers to download the default embedding model
   * in the same flow. `accept=true` triggers
   * `orchestrator.localModels.resolveEmbeddingOnboarding(true)` (pull
   * embedding + start paired daemon); `accept=false` only starts the
   * chat daemon.
   */
  onLocalModelsEmbeddingOnboardingResolved?(accept: boolean): void;
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
  /** Skills tab: open the uninstall confirmation for a global skill. */
  onSkillRemoveRequested?(name: string): void;
  /** Skills tab: delete the skill directory after confirmation. */
  onSkillRemoveConfirmed?(name: string): void;
  /** Skills hub: open the hub view and browse the configured taps. */
  onSkillHubOpen?(): void;
  /** Skills hub: re-browse the configured taps (clears the query). */
  onSkillHubRefresh?(): void;
  /** Skills hub: search the configured taps for a query. */
  onSkillHubSearch?(query: string): void;
  /** Skills hub: open the pre-install card for a row (fetches SKILL.md). */
  onSkillHubCardOpen?(row: HubSkillRow): void;
  /** Skills hub: stage + install the skill at `identifier`. */
  onSkillHubInstall?(identifier: string, source?: SkillSourceKind): void;
  /** Skills hub: commit a staged install awaiting confirmation. */
  onSkillInstallConfirmed?(identifier: string): void;
  /** Skills hub: discard a staged install awaiting confirmation. */
  onSkillInstallCancelled?(identifier: string): void;
  /** Memory tab: start the 5s refresh loop on first entry. */
  onMemoryAutoRefreshStart?(): void;
  /** Memory tab: open detail for a list row. */
  onMemoryDetailRequested?(row: MemorySummaryRow): void;
  /** Memory tab: open a note by id (link navigation). */
  onMemoryOpenNoteRequested?(noteId: number): void;
  /** Memory tab: BFS-expand neighbors for the open note (`g`). */
  onMemoryExpandNeighborsRequested?(noteId: number): void;
  /** MCP tab: start the 5s refresh loop on first entry. */
  onMcpAutoRefreshStart?(): void;
  /** Providers tab: refresh provider list on first entry. */
  onProvidersTabRefresh?(): void;
  /** Providers tab / LLM panel: switch the active text provider. */
  onProvidersSetActiveText?(id: string): void;
  /** Providers tab / LLM panel: select an exact chat model for a provider. */
  onProvidersSelectChatModel?(providerId: string, modelId: string): void;
  /**
   * LLM panel / bare `/model`: open the reopenable chat-model picker.
   * `providerId: null` targets the active text provider. This must be a
   * callback into `ProvidersOrchestrator.openChatModelPicker`, not a
   * dispatched reducer action: dispatch feeds the React reducer only,
   * and the event bus the orchestrator listens on is bridged into the
   * reducer one way (`bus.subscribe(dispatch)`), so a dispatched
   * request never reaches the orchestrator and the picker never opens.
   */
  onProvidersChatModelPickerRequested?(providerId: string | null): void;
  /**
   * Cloud pane / `/model`: make sure the inline model list has (or is
   * fetching) the catalog of `providerId` (`null` = active text
   * provider). Callback for the same reason as the picker request
   * above: only the callback layer reaches the orchestrator's bus.
   */
  onProvidersInlineModelsEnsureRequested?(providerId: string | null): void;
  /** Providers tab / LLM panel: switch the active embedding provider. */
  onProvidersSetActiveEmbedding?(id: string): void;
  /** Providers tab / LLM panel: select an exact embedding model. */
  onProvidersSelectEmbeddingModel?(providerId: string, modelId: string): void;
  /** MCP tab: open detail view for a server by name. */
  onMcpDetailRequested?(serverName: string): void;
  /**
   * MCP tab: persist a new server from a JSON-paste payload. The
   * orchestrator validates + writes `<stateDir>/config.json` and
   * emits one of `mcp_add_validation_failed` / `mcp_add_failed` /
   * `mcp_add_succeeded`. The runtime must be restarted for the new
   * server to actually connect — see `persistMcpServer`.
   */
  onMcpAddServerSubmit?(json: string): void;
  /**
   * MCP tab: remove an existing server by name from
   * `<stateDir>/config.json`. Variant α: the live `McpManager` is NOT
   * mutated — the operator restarts atomic-agent to drop the live
   * connection. Failures fold into `mcp_remove_failed`.
   */
  onMcpRemoveServer?(name: string): void;
  /** Providers tab: finish the add/configure wizard. */
  onProvidersWizardSubmit?(wizard: import("./providers/providers-wizard-state.js").ProvidersWizardState): void;
  /** Providers tab: remove a provider by id from config + registry. */
  onProvidersRemove?(id: string): void;
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
  /** Privacy tab: toggle anonymous analytics + error reporting (live). */
  onAnalyticsToggleRequested?(): void | Promise<void>;
  /** Privacy tab: set analytics to an explicit value (slash-command path). */
  onAnalyticsSetEnabledRequested?(enabled: boolean): void | Promise<void>;
  /**
   * Privacy tab: move the approval ladder to an explicit level (digit
   * hotkeys, arrow steps, `/privacy level 1..5`, and the `/privacy
   * approve on|off` aliases which map to 5 and 1). Persists
   * `agent.approvalLevel` and hot-applies it to the live gate.
   */
  onApprovalLevelSetRequested?(level: number): void | Promise<void>;
  /** Privacy tab: re-read the persisted `analytics.enabled` snapshot. */
  onPrivacyRefreshRequested?(): void;
  /** Import tab: run a dry-run preview of the Hermes import. */
  onImportPreview?(form: ImportFormState): void;
  /** Import tab: execute the import (write sessions / tasks / secrets). */
  onImportExecute?(form: ImportFormState): void;
  /** Startup self-update: user accepted the offer — run `install.sh`. */
  onUpdateConfirmed?(): void;
  /** Self-update settled: user pressed a key to re-exec the new binary. */
  onUpdateRestart?(): void;
  /**
   * Ctrl+N / `/window`: open a new OS terminal window running a fresh
   * `atomic-agent tui` in the same working directory.
   */
  onNewWindowRequested?(): void;
}

export interface TuiAppProps {
  session: TuiSessionInfo;
  bus: TuiEventBus;
  callbacks: TuiAppCallbacks;
  maxVisibleRows?: number;
  /** Optional initial debug tab / mode (e.g. after managed-mode wizard). */
  initialLayout?: InitialTuiLayoutOptions;
  /**
   * Decoded terminal mouse reports. Supplied by `tui-command.ts` when
   * mouse support is on; omitted (tests, `--no-mouse`) the app is
   * keyboard-only and every clickable surface simply never fires.
   */
  mouse?: MouseSource;
}

const DEFAULT_MAX_VISIBLE_ROWS = 14;
const CTRL_C_WINDOW_MS = 1500;

/**
 * Rows the chat transcript moves per wheel notch. Three keeps a flick
 * of the wheel useful on a long transcript without overshooting the
 * reply the operator is reading; the keyboard's own ±2 arrow scroll is
 * deliberately finer.
 */
const WHEEL_SCROLL_LINES = 3;

/**
 * Rotating placeholder pool shown in the prompt's empty state. Phrasing
 * intentionally nudges the operator toward concrete actions the agent
 * can execute locally — file ops, browser automation, codebase Q&A —
 * rather than open-ended chat.
 */
const PROMPT_PLACEHOLDERS: readonly string[] = [
  "Type a message or `/` for commands…",
  "Ask anything about your codebase…",
  "Try `/help` to see all commands",
  "What are you working on today?",
  "Inspect a file, run a search, draft a fix…",
];

export function TuiApp({
  session,
  bus,
  callbacks,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  initialLayout,
  mouse,
}: TuiAppProps): ReactElement {
  const [state, dispatch] = useReducer(reduceTuiState, { session, initialLayout }, (init) =>
    createInitialTuiState(init.session, DEFAULT_RING_BUFFER_SIZE, init.initialLayout),
  );
  const app = useApp();
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);
  const registryRef = useRef<MouseTargetRegistry | null>(null);
  registryRef.current ??= new MouseTargetRegistry();
  const registry = registryRef.current;
  // Click handlers run outside React's render pass, so they read state
  // through a ref rather than a closure that may be a frame stale.
  const stateRef = useRef(state);
  stateRef.current = state;
  const getState = useCallback(() => stateRef.current, []);

  useEffect(() => bus.subscribe(dispatch), [bus]);

  useEffect(() => {
    if (!mouse) return;
    return mouse.subscribe((event) => {
      registry.dispatch(event);
    });
  }, [mouse, registry]);

  useEffect(() => {
    callbacks.onProvidersTabRefresh?.();
  }, [callbacks]);

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
    if (state.uiMode === "debug" && state.activeTab === "memory") {
      callbacks.onMemoryAutoRefreshStart?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (state.uiMode === "debug" && state.activeTab === "mcp") {
      callbacks.onMcpAutoRefreshStart?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (state.uiMode === "debug" && state.activeTab === "privacy") {
      callbacks.onPrivacyRefreshRequested?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (
      state.uiMode === "debug" &&
      (state.activeTab === "providers" || state.activeTab === "llm")
    ) {
      callbacks.onProvidersTabRefresh?.();
    }
  }, [state.uiMode, state.activeTab, callbacks]);

  useEffect(() => {
    if (
      state.uiMode === "debug" &&
      (state.activeTab === "models" || state.activeTab === "llm")
    ) {
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
  const memoryTabActive =
    state.uiMode === "debug" && state.activeTab === "memory";
  const mcpTabActive =
    state.uiMode === "debug" && state.activeTab === "mcp";
  const providersTabActive =
    state.uiMode === "debug" && state.activeTab === "providers";
  const localModelsTabActive =
    state.uiMode === "debug" && state.activeTab === "models";
  const llmTabActive = state.uiMode === "debug" && state.activeTab === "llm";
  const telegramTabActive =
    state.uiMode === "debug" && state.activeTab === "telegram";
  const importTabActive =
    state.uiMode === "debug" && state.activeTab === "import";
  const privacyTabActive =
    state.uiMode === "debug" && state.activeTab === "privacy";
  const terminalSize = useTerminalSize();
  const sidebarVisible =
    state.uiMode === "chat" && isSidebarVisible(terminalSize.columns);
  // The rail takes a share of the terminal rather than a flat 30
  // columns, and its two panes get a row budget cut from the terminal
  // height — Ink 7 overlaps rather than clips an over-tall frame, so
  // an unbudgeted rail garbles short windows.
  const sidebarWidth = computeSidebarWidth(terminalSize.columns);
  const sidebarRows = computeSidebarRowBudget(terminalSize.rows);
  const sidebarFocused = sidebarVisible && state.chatFocus === "sidebar";
  const editorFocus =
    !state.pendingApproval &&
    // The update offer claims y / n / Esc; keep the editor unfocused so
    // those keystrokes never leak into the input buffer. The post-update
    // "press any key to restart" prompt claims every key for the same reason.
    !state.updatePrompt &&
    state.updateStatus !== "done" &&
    // When the slash-command palette is open the editor must hold focus
    // regardless of the active debug tab so the operator can type the
    // command and drive ↑↓ / tab / enter selection. Panels that open the
    // palette explicitly (e.g. the LLM tab via `/`) rely on this.
    (state.slashPaletteOpen ||
      (!tasksTabActive &&
        !skillsTabActive &&
        !memoryTabActive &&
        !mcpTabActive &&
        !providersTabActive &&
        !llmTabActive &&
        !telegramTabActive &&
        !importTabActive &&
        !privacyTabActive &&
        !sidebarFocused &&
        !(
          localModelsTabActive &&
          (state.localModelsPanel.pull !== null ||
            state.localModelsPanel.mode === "backendUpdate" ||
            state.localModelsPanel.removeConfirmId !== null)
        )));

  // When the sidebar collapses below the width threshold (terminal
  // resized smaller), focus must follow back to the editor so Tab does
  // not strand the operator on an invisible surface.
  useEffect(() => {
    if (!sidebarVisible && state.chatFocus === "sidebar") {
      dispatch({ type: "chat_focus_set", focus: "editor" });
    }
  }, [sidebarVisible, state.chatFocus]);

  /**
   * Routes a key to whichever Observe / Manage panel is on screen.
   * Returns `null` when no panel owns the surface (chat mode), `true` /
   * `false` for handled / declined. Shared by the keyboard hook and the
   * mouse wheel, so a wheel notch means exactly what an arrow key means
   * on every panel — including the clamping each panel does itself.
   */
  const routePanelKey = (input: string, key: Key): boolean | null => {
    const ctx = { state, dispatch, callbacks };
    if (tasksTabActive) return handleTasksTabKey(input, key, ctx);
    if (skillsTabActive) return handleSkillsTabKey(input, key, ctx);
    if (memoryTabActive) return handleMemoryTabKey(input, key, ctx);
    if (mcpTabActive) return handleMcpTabKey(input, key, ctx);
    if (providersTabActive) return handleProvidersTabKey(input, key, ctx);
    if (llmTabActive) return handleLlmPanelKey(input, key, ctx);
    if (localModelsTabActive) return handleLocalModelsTabKey(input, key, ctx);
    if (telegramTabActive) return handleTelegramTabKey(input, key, ctx);
    if (importTabActive) return handleImportTabKey(input, key, ctx);
    if (privacyTabActive) return handlePrivacyTabKey(input, key, ctx);
    return null;
  };

  // While a modal or confirm owns the keyboard it owns the mouse too:
  // raising the floor stops a click from reaching the list rendered
  // behind it. Same predicate the key layer gates on.
  const modalOwnsInput =
    Boolean(state.pendingApproval) ||
    Boolean(state.updatePrompt) ||
    state.updateStatus === "done" ||
    state.sessionPickerOpen ||
    state.themePickerOpen ||
    state.slashPaletteOpen ||
    isPanelModalOpen(state);
  useEffect(() => {
    registry.setMinLayer(modalOwnsInput ? MOUSE_LAYER_MODAL : MOUSE_LAYER_BASE);
  }, [registry, modalOwnsInput]);

  /**
   * Whole-viewport wheel target. Scrolling over the chat moves the
   * transcript; over a panel it walks that panel's cursor. Registered
   * at the base layer and covering everything, so it only ever fires
   * for events no smaller target claimed.
   */
  const contentMouseRef = useRef<DOMElement | null>(null);
  const wheelHandler = (hit: MouseHit): boolean => {
    if (hit.event.kind !== "wheel" || !hit.event.wheel) return false;
    const direction = hit.event.wheel;
    if (state.uiMode === "chat") {
      dispatch({
        type: "chat_scrolled",
        delta: direction === "up" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES,
      });
      return true;
    }
    return routePanelKey("", arrowKey(direction)) === true;
  };
  // TuiApp renders the provider, so it cannot consume the context hook
  // itself — it registers on the registry it owns. The handler is read
  // through a ref so the subscription survives every re-render.
  const wheelHandlerRef = useRef(wheelHandler);
  wheelHandlerRef.current = wheelHandler;
  useEffect(
    () =>
      registry.register({
        ref: contentMouseRef,
        layer: MOUSE_LAYER_BASE,
        handler: (hit) => wheelHandlerRef.current(hit),
      }),
    [registry],
  );

  useInput((input, key) => {
    const appHandled = handleAppKey(input, key, {
      state,
      dispatch,
      callbacks,
      ctrlCArmed,
      setCtrlCArmed,
      sidebarVisible,
    });
    if (appHandled) return;
    // While the slash-command palette is open, let the (now-focused)
    // editor's own input hook own every keystroke — typing, ↑↓ palette
    // navigation, tab completion, enter to run, esc to close. Routing to
    // a debug-tab panel here would re-interpret letters as hotkeys.
    if (state.slashPaletteOpen) return;
    const panelHandled = routePanelKey(input, key);
    if (panelHandled !== null) {
      handlePanelEscape(key, { panelHandled, editorFocus, dispatch });
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
    if (state.themePickerOpen) {
      // Cancel: revert the live-preview swap to the theme active on open.
      if (isThemeName(state.themePickerOriginal)) {
        setActiveTheme(THEMES[state.themePickerOriginal]);
      }
      dispatch({ type: "theme_picker_closed" });
      return;
    }
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_closed" });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_closed" });
      return;
    }
    if (state.pendingApproval) return;
    // Esc with the chat scrolled away from the bottom snaps back to
    // the latest reply before doing anything else — avoids a confused
    // "why didn't my Esc abort?" when the operator left the scroll
    // pinned mid-history.
    if (state.chatScrollOffset > 0) {
      dispatch({ type: "chat_scroll_reset" });
      return;
    }
    // A debug panel is open: Esc is the way back to Run, exactly as the
    // hint strip advertises. The Observe tabs (Feed / World / Reasoning /
    // Logs / LLM logs) have no key layer of their own, so `handlePanelEscape`
    // never sees the keypress and the editor — which stays focused there so
    // the operator can keep typing while watching the feed — used to fall
    // through to the quit branch below and kill the agent instead.
    if (state.uiMode === "debug") {
      dispatch({ type: "ui_mode_set", mode: "chat" });
      return;
    }
    // Esc never quits. Everywhere else in the TUI it means cancel / back
    // one level, so a single unannounced press killing the agent — and
    // the half-typed message with it — was a trap: no hint strip ever
    // advertised it, while Ctrl+C deliberately asks twice. Quitting stays
    // on Ctrl+C twice and `/quit`; Esc just clears the draft.
    if (canAcceptMessage(state)) {
      if (state.inputValue.length > 0) {
        dispatch({ type: "input_changed", value: "" });
      }
      return;
    }
    callbacks.onAbort();
    dispatch({ type: "abort_requested" });
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

  // Live-preview: swap the active palette to the theme at `cursor` (clamped)
  // so the whole UI repaints as the operator moves through the list. The
  // reducer clamps identically when it folds the cursor move.
  const previewThemeAt = useCallback((cursor: number) => {
    const max = THEME_NAMES.length - 1;
    const clamped = Math.min(max, Math.max(0, cursor));
    const name = THEME_NAMES[clamped];
    if (name) setActiveTheme(THEMES[name]);
  }, []);

  const onHistoryPrev = useCallback(() => {
    if (state.themePickerOpen) {
      previewThemeAt(state.themePickerCursor - 1);
      dispatch({ type: "theme_picker_cursor_moved", delta: -1 });
      return;
    }
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_cursor_moved", delta: -1 });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_cursor_moved", delta: -1 });
      return;
    }
    dispatch({ type: "input_history_navigated", delta: -1 });
  }, [state.slashPaletteOpen, state.sessionPickerOpen, state.themePickerOpen, state.themePickerCursor]);

  const onHistoryNext = useCallback(() => {
    if (state.themePickerOpen) {
      previewThemeAt(state.themePickerCursor + 1);
      dispatch({ type: "theme_picker_cursor_moved", delta: 1 });
      return;
    }
    if (state.sessionPickerOpen) {
      dispatch({ type: "session_picker_cursor_moved", delta: 1 });
      return;
    }
    if (state.slashPaletteOpen) {
      dispatch({ type: "slash_palette_cursor_moved", delta: 1 });
      return;
    }
    dispatch({ type: "input_history_navigated", delta: 1 });
  }, [state.slashPaletteOpen, state.sessionPickerOpen, state.themePickerOpen, state.themePickerCursor]);

  // Pin the layout to the live terminal height **only** under a real
  // TTY. ink-testing-library's mock stdout reports a fake `rows` value
  // (or none at all) which would clip the content to ~24 rows and make
  // the smoke tests assert against an overlapped frame. In production
  // the alt-screen + `height={rows}` combo gives us the opencode-style
  // pinned-input-at-bottom UX.
  const isTty = Boolean(process.stdout.isTTY);
  const rootHeight = isTty ? terminalSize.rows : undefined;
  const promptLlm = selectPromptLlmMeta(state);
  // No local backend chosen yet ⇒ no local health to report. Without this the
  // splash screen of a fresh install announces that a server the user never
  // configured is down, which reads as a broken install rather than an
  // un-started one. `localConfigured` latches on as soon as local is really
  // the route (config says so, or a probe answered), so real local users keep
  // the ● / ○ signal they rely on.
  const promptLeftSlot = promptLlm.usesLocalHealth ? (
    state.llmHealth.localConfigured ? (
      <LlmHealthBadge health={state.llmHealth} />
    ) : null
  ) : (
    <Text>
      <Text color="green" bold>
        ●
      </Text>
      <Text color="gray"> {promptLlm.cloudLabel ?? "cloud"}</Text>
    </Text>
  );
  // While a turn is running the meta-row's job changes: the operator
  // needs to know what Enter will do to the message they are typing far
  // more than they need the context-window size.
  const promptRightSlot =
    state.status === "running" || state.status === "awaiting_approval" ? (
      <Text>
        <Text color={theme.colors.accentSoft} bold>
          {"\u23ce"} {state.whileBusyMode}
        </Text>
        <Text color={theme.colors.muted}> (ctrl+t)</Text>
      </Text>
    ) : state.llmHealth.contextWindow !== null ? (
      <Text color={theme.colors.muted}>
        ctx {state.llmHealth.contextWindow}
      </Text>
    ) : null;

  return (
    <MouseProvider
      registry={registry}
      dispatch={dispatch}
      callbacks={callbacks}
      getState={getState}
    >
    <Box
      flexDirection="column"
      paddingLeft={2}
      ref={contentMouseRef}
      {...(rootHeight ? { height: rootHeight } : {})}
    >
      <Box flexShrink={0}>
        <StatusBar state={state} />
      </Box>
      {state.uiMode === "chat" ? (
        <Box flexShrink={0}>
          <RunModeBar panel={state.runModePanel} />
        </Box>
      ) : null}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
            {state.uiMode === "chat" ? (
              <ChatLog state={state} dispatch={dispatch} />
            ) : (
              <DebugPane
                state={state}
                maxVisible={maxVisibleRows}
                onMcpAddJsonChange={(json) =>
                  dispatch({ type: "mcp_add_json_changed", json })
                }
                onMcpAddSubmit={(json) =>
                  callbacks.onMcpAddServerSubmit?.(json)
                }
                onMcpAddCancel={() =>
                  dispatch({ type: "mcp_add_modal_closed" })
                }
              />
            )}
          </Box>
          {state.pendingApproval ? (
            <Box flexShrink={0}>
              <ApprovalModal request={state.pendingApproval} />
            </Box>
          ) : null}
          {state.runModePanel.picker ? (
            <Box flexShrink={0}>
              <RunModePicker panel={state.runModePanel} />
            </Box>
          ) : null}
          {state.sessionPickerOpen ? (
            <Box flexShrink={0}>
              <SessionPicker
                sessions={state.sessionPickerList}
                cursor={state.sessionPickerCursor}
                currentSessionId={state.session.sessionId}
              />
            </Box>
          ) : null}
          {state.themePickerOpen ? (
            <Box flexShrink={0}>
              <ThemePicker
                cursor={state.themePickerCursor}
                original={state.themePickerOriginal}
              />
            </Box>
          ) : null}
          {state.slashPaletteOpen ? (
            <SlashPalette
              query={state.slashQuery}
              cursor={state.slashPaletteCursor}
            />
          ) : null}
          {state.tasksPanel.cancelConfirm ? (
            <Box flexShrink={0}>
              <TasksCancelModal confirm={state.tasksPanel.cancelConfirm} />
            </Box>
          ) : null}
          {state.updatePrompt ? (
            <Box flexShrink={0}>
              <UpdateModal
                current={state.updatePrompt.current}
                latest={state.updatePrompt.latest}
              />
            </Box>
          ) : null}
          {state.updateStatus === "running" ? (
            <Box flexShrink={0}>
              <UpdateIndicator />
            </Box>
          ) : null}
          {state.updateStatus === "done" ? (
            <Box flexShrink={0}>
              <UpdateRestartPrompt />
            </Box>
          ) : null}
          <QueuedMessages queued={state.queuedMessages} width={terminalSize.columns} />
          <PromptShell
            value={state.inputValue}
            placeholder="Type a message or `/` for commands…"
            rotatingPlaceholders={PROMPT_PLACEHOLDERS}
            model={promptLlm.model}
            provider={promptLlm.provider}
            leftSlot={promptLeftSlot}
            rightSlot={promptRightSlot}
            focus={editorFocus}
            disabled={!canTypeMessage(state)}
            onChange={onEditorChange}
            onSubmit={submit}
            onEscape={onEscape}
            onTab={onTab}
            onAutocomplete={onTab}
            onHistoryPrev={onHistoryPrev}
            onHistoryNext={onHistoryNext}
          />
          <HotkeyHint state={state} ctrlCArmed={ctrlCArmed} />
        </Box>
        {sidebarVisible ? (
          <Sidebar
            width={sidebarWidth}
            maxSessionRows={sidebarRows.sessions}
            maxTaskRows={sidebarRows.tasks}
            sessions={state.recentSessions}
            sessionsCursor={state.sidebarCursor}
            currentSessionId={state.session.sessionId}
            tasks={selectSidebarTasks(state.tasksPanel.rows)}
            tasksCursor={state.sidebarTasksCursor}
            activeSection={state.sidebarSection}
            focused={sidebarFocused}
          />
        ) : null}
      </Box>
    </Box>
    </MouseProvider>
  );
}

