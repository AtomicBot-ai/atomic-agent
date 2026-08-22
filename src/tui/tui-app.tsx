import { ContextChip } from "./components/context-chip.js";
import { ContextPanel } from "./components/context-panel.js";
import { selectContextUsage } from "./select-context-usage.js";
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
  approvalHotkey,
  handleAppKey,
  submitApprovalPath,
  handlePanelEscape,
  isPanelModalOpen,
} from "./app-key-bindings.js";
import { appChromeRows } from "./components/debug-pane.js";
import { MenuPopup } from "./menu/menu-popup.js";
import type { MenuNode } from "./menu/menu-registry.js";
import { ApprovalModal } from "./approval-modal.js";
import { ChatLog } from "./components/chat-log.js";
import {
  ComposerSwitchPopup,
  runComposerSwitchRow,
  selectComposerBackendMeta,
  type ComposerSwitchRow,
} from "./composer-switch/index.js";
import { DebugPane } from "./components/debug-pane.js";
import { HotkeyHint } from "./components/hotkey-hint.js";
import { PromptShell } from "./components/prompt-shell.js";
import { QueuedMessages } from "./components/queued-messages.js";
import { SessionDeleteModal } from "./components/session-delete-modal.js";
import { SessionPicker } from "./components/session-picker.js";
import { ThemePicker } from "./components/theme-picker.js";
import {
  isThemeName,
  setActiveTheme,
  setBackdropDimmed,
  theme,
  THEME_NAMES,
  THEMES,
} from "./theme/theme.js";
import { Sidebar } from "./components/sidebar.js";
import { selectSidebarTasks } from "./sidebar-tasks-selector.js";
import { SlashPalette } from "./components/slash-palette.js";
import { StatusBar } from "./components/status-bar.js";
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
import { handleEditorSubmit, runSlashCommand } from "./submit-handler.js";
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
import { isPrimaryPress } from "./mouse/mouse-event.js";
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

/**
 * Columns of air between the rail's right edge and the chat column. The
 * rail paints its own ground, so without a gutter the transcript starts
 * one cell after a block of colour and reads as if it were inside the
 * panel. Subtracted from `mainColumnWidth` as well, or the hairline and
 * the hint strip overflow the row they are measured for.
 */
const RAIL_GUTTER_COLUMNS = 3;

/**
 * How long after a modal opens its backdrop refuses to dismiss it. One
 * frame is enough for the modal's own click targets to register; 150ms
 * covers a loaded machine without being long enough to swallow a
 * deliberate click away.
 */
const MODAL_CLICK_GRACE_MS = 150;

/** How long a composer notice ("copied 3 characters") stays up. */
const COMPOSER_NOTICE_MS = 2500;

/**
 * A one-row hairline. `flexShrink={0}` so a tall chat never eats it, and
 * the glyph run is built from the width the caller measured rather than
 * `width="100%"`: Ink pads a percentage-width Box with spaces, which
 * paints a gap in the rule wherever the row is wider than the text.
 */
function Rule({ width }: { width: number }): ReactElement {
  return (
    <Box flexShrink={0}>
      <Text color={theme.colors.border}>
        {theme.glyphs.toolBoxHorizontal.repeat(Math.max(0, width))}
      </Text>
    </Box>
  );
}

export interface TuiAppCallbacks {
  onApprovalDecision(
    approvalId: string,
    approved: boolean,
    grant?: ApprovalGrantScope,
  ): void;
  /**
   * Approve the pending call at an operator-typed target instead of the
   * proposed one (`[e]` on the prompt). The raw string travels to the
   * tool, which resolves and re-categorises it — a target on a
   * different rung of the approval ladder comes back as a fresh prompt.
   */
  onApprovalRetarget?(approvalId: string, path: string): void;
  /**
   * A chat message submitted while a prompt is up: denies that one call
   * with the message as its reason and folds the same text into the
   * running turn.
   */
  onApprovalReply?(approvalId: string, message: string): void;
   /**
   * Remove a session for good. Confirmed by the operator in the dialog
   * the rail's `x` opens — the host does the deleting and decides where
   * the UI lands if the current thread was the one removed.
   */
  onSessionDeleteConfirmed?(sessionId: string): void;
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
  onLocalModelsAutoUpdateToggleRequested?(): void | Promise<void>;
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
  /** Providers tab: abandon a running pre-save key check. */
  onProvidersWizardSubmitCancel?(): void;
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
   * Decoded terminal mouse reports. `tui-command.ts` always passes it,
   * whatever `tui.mouse` says at startup: whether reports actually flow
   * is decided upstream by the tracking controller, which `/mouse
   * on|off` flips live, and this prop is fixed at mount. Omitted only in
   * tests, where the app is keyboard-only and every clickable surface
   * simply never fires.
   */
  mouse?: MouseSource;
}

const DEFAULT_MAX_VISIBLE_ROWS = 14;
const CTRL_C_WINDOW_MS = 1500;
/**
 * How long a `ctrl+g` leader waits for its chord before disarming itself.
 * The same window as Ctrl+C on purpose — both are "you started a two-key
 * gesture, finish it" timers, and an armed leader is not free to leave
 * pending: it unfocuses the editor and eats the next keystroke.
 */
const MENU_LEADER_WINDOW_MS = CTRL_C_WINDOW_MS;
/** Left gutter of the whole app frame — see the root `paddingLeft`. */
const ROOT_PADDING_COLUMNS = 2;

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
  const [menuLeaderArmed, setMenuLeaderArmed] = useState(false);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);
  const menuLeaderTimer = useRef<NodeJS.Timeout | null>(null);
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

  // A leader that is never followed by a chord must not stay armed: it
  // holds the editor unfocused and swallows whatever is typed next.
  useEffect(() => {
    if (!menuLeaderArmed) return;
    menuLeaderTimer.current = setTimeout(
      () => setMenuLeaderArmed(false),
      MENU_LEADER_WINDOW_MS,
    );
    return () => {
      if (menuLeaderTimer.current) clearTimeout(menuLeaderTimer.current);
    };
  }, [menuLeaderArmed]);

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
    state.uiMode === "chat" &&
    isSidebarVisible(terminalSize.columns, terminalSize.rows);
  // The rail takes a share of the terminal rather than a flat 30
  // columns, and its two panes get a row budget cut from the terminal
  // height — Ink 7 overlaps rather than clips an over-tall frame, so
  // an unbudgeted rail garbles short windows. A window too short for
  // even one row per pane drops the rail entirely.
  const sidebarWidth = computeSidebarWidth(terminalSize.columns);
  const sidebarRows = computeSidebarRowBudget(terminalSize.rows);
  // Columns left for the main column once the frame gutter and the
  // right rail have taken their cut — what the one-row hint strip has
  // to fit inside.
  const mainColumnWidth = Math.max(
    0,
    terminalSize.columns -
      ROOT_PADDING_COLUMNS -
      (sidebarVisible ? sidebarWidth + RAIL_GUTTER_COLUMNS : 0),
  );
  const sidebarFocused = sidebarVisible && state.chatFocus === "sidebar";
  /**
   * The composer belongs to the Run screen. Observe and Manage are for
   * watching and configuring, and a prompt sitting under a settings
   * panel invites a message nobody is going to read from there.
   *
   * The three exceptions are surfaces whose keyboard the composer owns
   * while they are open: the slash palette types into its buffer, and
   * the theme and session pickers are closed by the editor's own Esc.
   * `handleAppKey` explicitly declines Esc while the palette is open
   * (`!state.slashPaletteOpen`), so unmounting the composer under it
   * would leave the palette with no way out at all.
   */
  const composerVisible =
    state.uiMode === "chat" ||
    state.slashPaletteOpen ||
    state.themePickerOpen ||
    state.sessionPickerOpen;

  /**
   * Live mirror of {@link composerVisible}. The unmounting editor keeps
   * the callbacks from its last render — the one where the composer was
   * still on screen — so a guard that closed over the boolean would read
   * `true` exactly when it matters. The ref's identity is stable, so the
   * stale closure reads the current value through it. (Render-phase
   * write: derived from state, never written from an effect.)
   */
  const composerVisibleRef = useRef(true);
  composerVisibleRef.current = composerVisible;

  const editorFocus =
    !state.menuOpen &&
    !state.contextPanelOpen &&
    // A route switch owns ↑↓ / ←→ / Enter while it is up; the editor
    // keeping focus would act on the same keystroke a second time.
    state.composerSwitch === null &&
    !menuLeaderArmed &&
    // An approval prompt no longer takes the keyboard away: the
    // operator answers the agent in the same field they always type in,
    // and `approvalHotkey` decides per keystroke whether it is a
    // decision or text. The one exception is the prompt's own target
    // field, which owns input while it is open.
    state.approvalPathDraft === null &&
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

  // When the sidebar collapses below the width or height threshold
  // (terminal resized smaller), focus must follow back to the editor so
  // Tab does not strand the operator on an invisible surface.
  useEffect(() => {
    if (!sidebarVisible && state.chatFocus === "sidebar") {
      dispatch({ type: "chat_focus_set", focus: "editor" });
    }
  }, [sidebarVisible, state.chatFocus]);

  const activateMenuNode = useCallback(
    (node: MenuNode) => {
      // A node that carries a slash name is *run as that command*, so the
      // menu never grows a second dispatch path beside the slash handler.
      if (node.slash) {
        runSlashCommand(`/${node.slash.name}`, state, dispatch, callbacks);
        return;
      }
      if (node.kind === "place") {
        if (node.tab) {
          dispatch({ type: "ui_mode_set", mode: "debug" });
          dispatch({ type: "tab_changed", tab: node.tab });
        } else {
          dispatch({ type: "ui_mode_set", mode: "chat" });
        }
      }
    },
    [state, callbacks],
  );

  const activateComposerSwitch = useCallback(
    (row: ComposerSwitchRow) =>
      runComposerSwitchRow(row, state, dispatch, callbacks),
    [state, callbacks],
  );

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
    state.menuOpen ||
    state.contextPanelOpen ||
    state.composerSwitch !== null ||
    Boolean(state.sessionDelete) ||
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

  /**
   * The menu's backdrop. Registered on the same root box as the wheel
   * target but at the modal layer, so it is eligible exactly while the
   * menu owns input — and, being the largest box on that layer, it is
   * sorted last: every target inside the popup gets the event first.
   * That ordering is what makes "click outside to close" safe to state
   * as one rule instead of a list of exceptions.
   */
  const menuBackdropHandler = (hit: MouseHit): boolean => {
    const open =
      state.menuOpen ||
      state.contextPanelOpen ||
      state.composerSwitch !== null ||
      Boolean(state.sessionDelete);
    if (!open) return false;
    if (hit.event.kind === "wheel") return true;
    if (!isPrimaryPress(hit.event)) return false;
    // A modal's own targets register in an effect that flushes a frame
    // after it first paints. In that window the backdrop is the only
    // eligible target, so a second click arriving fast — a double-click
    // on the rail's `[x]`, or an impatient one on `ctrl+p` — would be
    // read as "clicked outside" and dismiss the surface that just
    // opened. Ignore presses until the modal has had that frame.
    if (Date.now() - modalOpenedAtRef.current < MODAL_CLICK_GRACE_MS) {
      return true;
    }
    // Clicking away from a destructive confirmation cancels it — the
    // same dismissal the menu gets, and the safe outcome either way.
    dispatch(
      state.sessionDelete
        ? { type: "session_delete_closed" }
        : state.contextPanelOpen
          ? { type: "context_panel_closed" }
          : state.composerSwitch
            ? { type: "composer_switch_closed" }
            : { type: "menu_closed" },
    );
    return true;
  };
  // Stamped when a backdrop-owning surface opens; read by the handler
  // above. A ref rather than state: it must not trigger a render.
  const modalOpenedAtRef = useRef(0);
  const backdropOwner =
    state.menuOpen ||
    state.contextPanelOpen ||
    state.composerSwitch !== null ||
    Boolean(state.sessionDelete);
  useEffect(() => {
    if (backdropOwner) modalOpenedAtRef.current = Date.now();
  }, [backdropOwner]);
  const menuBackdropRef = useRef(menuBackdropHandler);
  menuBackdropRef.current = menuBackdropHandler;
  useEffect(
    () =>
      registry.register({
        ref: contentMouseRef,
        layer: MOUSE_LAYER_MODAL,
        handler: (hit) => menuBackdropRef.current(hit),
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
      menuLeaderArmed,
      setMenuLeaderArmed,
      activateMenuNode,
      activateComposerSwitch,
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
    // Esc back to Run, for the tabs that have no key layer of their own
    // (the Observe five: feed / world / reasoning / logs / llm logs).
    // `handlePanelEscape` above never sees their keys — it runs only
    // when a panel handler claimed something — and this used to be the
    // editor's job, through the `onEscape` it no longer has here.
    if (
      !composerVisible &&
      key.escape &&
      !isPanelModalOpen(state) &&
      state.uiMode === "debug"
    ) {
      dispatch({ type: "ui_mode_set", mode: "chat" });
    }
  });

  const submit = useCallback(
    (buffer: string) => {
      // Same stale-subscription window as `onEditorChange`: an Enter
      // that arrives while the composer is leaving must not send.
      if (!composerVisibleRef.current) return;
      handleEditorSubmit(buffer, state, dispatch, callbacks);
    },
    [state, callbacks],
  );

  const onEditorChange = useCallback(
    (next: string) => {
      // An editor that is unmounting keeps its `useInput` subscription
      // until the passive effect tears it down, one tick later — so the
      // composer leaving the screen still delivers the keystroke that
      // took the operator off the Run screen. Refuse edits whenever the
      // composer is not on screen: its buffer is not reachable then, and
      // a "/" seeded into it would open the slash palette over a panel
      // that owns that key itself.
      if (!composerVisibleRef.current) return;
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
    // Reached only with a draft in the buffer: an empty buffer means
    // Esc was claimed as `abort` before the editor ever saw it. Clearing
    // the draft hands the y / s / e / n keys back.
    if (state.pendingApproval) {
      if (state.inputValue.length > 0) {
        dispatch({ type: "input_changed", value: "" });
      }
      return;
    }
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
    // Only while idle: with a turn in flight the running hint says
    // `[esc] abort`, and `handleAppKey` claims the key for exactly that —
    // navigating away at the same time would make one keypress do two
    // unrelated things.
    if (state.uiMode === "debug" && canAcceptMessage(state)) {
      dispatch({ type: "ui_mode_set", mode: "chat" });
      return;
    }
    // PRECEDENCE, decided rather than inherited from branch order: while
    // a turn is in flight abort wins and the draft is left alone — and
    // the abort itself is claimed by `handleAppKey`, on a subscription
    // that fires whether or not the editor is live, so keeping a copy of
    // the branch here would fire `onAbort` twice per keypress. Abort is
    // the destructive, time-critical action; a draft is cheap to keep —
    // one more Esc, this time idle, clears it. The running hint strip
    // says `abort, draft kept` whenever there is a draft (see
    // `hotkey-hint.tsx`).
    if (!canAcceptMessage(state)) return;
    // Idle: Esc never quits. Everywhere else in the TUI it means cancel /
    // back one level, so a single unannounced press killing the agent —
    // and the half-typed message with it — was a trap: no hint strip ever
    // advertised it, while Ctrl+C deliberately asks twice. Quitting stays
    // on Ctrl+C twice and `/quit`; Esc clears the draft first.
    if (state.inputValue.length > 0) {
      dispatch({ type: "input_changed", value: "" });
      return;
    }
    // Nothing left to cancel: Esc opens the menu. It is the LAST branch
    // on purpose — abort, close, back and clear-draft all outrank it, so
    // the key keeps every meaning it already had and gains one only when
    // it would otherwise have done nothing. `ctrl+p` still opens the
    // menu from anywhere, including mid-turn.
    dispatch({ type: "menu_path_set", path: null });
    dispatch({ type: "menu_cursor_set", cursor: 0 });
    dispatch({ type: "menu_opened" });
  }, [state, callbacks]);

  /**
   * The composer's stand-down rule. Ink hands a keypress to every
   * subscription, so without this the same `y` would both answer the
   * prompt and type itself into the buffer.
   */
  const composerClaimKey = useCallback(
    (input: string, key: Key) => approvalHotkey(state, input, key) !== null,
    [state],
  );

  const onApprovalPathOpen = useCallback(() => {
    if (!state.pendingApproval?.redirectablePath) return;
    dispatch({
      type: "approval_path_edit_opened",
      path: state.pendingApproval.redirectablePath,
    });
  }, [state.pendingApproval]);

  const onApprovalPathSubmit = useCallback(
    (value: string) => {
      const request = state.pendingApproval;
      if (!request) return;
      const trimmed = value.trim();
      // An empty field is not a decision: keep the prompt up rather
      // than approving a write with no target.
      if (trimmed.length === 0) return;
      submitApprovalPath(request, trimmed, { dispatch, callbacks });
    },
    [state.pendingApproval, callbacks],
  );
   /**
   * Clicking the prompt takes the keyboard back from the rail. Without
   * this the caret moved but the arrow keys still walked the session
   * list, which is the behaviour of no other application anywhere.
   */
  const focusEditorFromClick = useCallback(() => {
    if (state.chatFocus === "editor") return;
    dispatch({ type: "chat_focus_set", focus: "editor" });
  }, [state.chatFocus]);

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
  // Render-phase on purpose: `theme` is a read-at-render proxy, and children
  // render after this body runs, so the flag is already correct for them.
  setBackdropDimmed(
    state.menuOpen || state.contextPanelOpen || state.composerSwitch !== null,
  );


  const isTty = Boolean(process.stdout.isTTY);
  const rootHeight = isTty ? terminalSize.rows : undefined;
  // Rows the content pane actually has, so the overlay can sit on its bottom
  // edge and cap its own height. Same budget the debug pane already uses.
  const menuPaneRows = Math.max(
    6,
    terminalSize.rows - appChromeRows(composerVisible),
  );
  // The switch popup gets the pane's *real* row count, floor of none:
  // it sheds its own chrome down to a three-row frame, and handing it
  // the menu's 6-row floor on a shorter pane made it paint over the
  // composer instead of shrinking.
  const switchPaneRows = Math.max(
    0,
    terminalSize.rows - appChromeRows(composerVisible),
  );
  const promptLlm = selectPromptLlmMeta(state);
  // The backend control carries the health dot the standalone pill used
  // to: `selectComposerBackendMeta` keeps the `localConfigured` guard
  // that stops a fresh install from announcing a server nobody
  // configured is down.
  const promptBackend = selectComposerBackendMeta(state);
  // A notice outranks the route for the couple of seconds it is up: it
  // is the answer to a keystroke the operator just made, and the route
  // is ambient.
  useEffect(() => {
    if (!state.composerNotice) return;
    const timer = setTimeout(
      () => dispatch({ type: "composer_notice", text: null }),
      COMPOSER_NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [state.composerNotice]);

  const promptLeftSlot = state.composerNotice ? (
    <Text color={theme.colors.success}>{state.composerNotice}</Text>
  ) : null;
  // While a turn is running the meta-row gains a second job: the operator
  // needs to know what Enter will do to the message they are typing.
  // Running only: during a pending approval every key routes to the
  // approval modal first, so both Enter-routing and the ctrl+t flip are
  // dead there — advertising them would promise bindings that do nothing.
  //
  // What used to live here when idle was `ctx <window>` — the *size* of
  // the context window, which never changes and never told anyone
  // anything. The chip below reports how much of it is in use instead.
  const promptRightSlot =
    state.status === "running" ? (
      <Text>
        <Text color={theme.colors.accentSoft} bold>
          {"\u23ce"} {state.whileBusyMode}
        </Text>
        <Text color={theme.colors.muted}> (ctrl+t)</Text>
      </Text>
    ) : null;
  const contextUsage = selectContextUsage(state);
  const promptContextSlot = contextUsage ? (
    <ContextChip usage={contextUsage} />
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
      paddingLeft={ROOT_PADDING_COLUMNS}
      ref={contentMouseRef}
      {...(rootHeight ? { height: rootHeight } : {})}
    >
      {/*
        The rail carries the brand, the version and the way to the menu,
        but NOT where you are — so the one-row bar stays either way and
        keeps the breadcrumb on screen. When the rail is up the bar drops
        its own brand lockup, since two copies of it read as a rendering
        bug rather than as chrome.
      */}
      <Box flexShrink={0}>
        <StatusBar state={state} brand={!sidebarVisible} />
      </Box>
      {/*
        The design separates the top bar and the hint strip from the
        content with a hairline. In a terminal that is a row of box-drawing
        characters — the one honest way to draw a 1px rule when the
        smallest unit you own is a cell.
      */}
      <Rule width={terminalSize.columns - ROOT_PADDING_COLUMNS} />
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
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
        <Box
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
          {...(sidebarVisible ? { paddingLeft: RAIL_GUTTER_COLUMNS } : {})}
        >
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            overflow="hidden"
            position="relative"
          >
            {state.uiMode === "chat" ? (
              <ChatLog state={state} dispatch={dispatch} />
            ) : (
              <DebugPane
                state={state}
                maxVisible={maxVisibleRows}
                composerVisible={composerVisible}
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
            {state.sessionDelete ? (
              <SessionDeleteModal
                confirm={state.sessionDelete}
                availableRows={menuPaneRows}
                availableColumns={
                  terminalSize.columns - 4 - (sidebarVisible ? sidebarWidth : 0)
                }
                onConfirm={(sessionId) => {
                  callbacks.onSessionDeleteConfirmed?.(sessionId);
                  dispatch({ type: "session_delete_closed" });
                }}
                onCancel={() => dispatch({ type: "session_delete_closed" })}
                onFocus={(cursor) =>
                  dispatch({ type: "session_delete_cursor_set", cursor })
                }
              />
            ) : null}
            {state.contextPanelOpen ? (
              <ContextPanel
                usage={contextUsage}
                availableRows={menuPaneRows}
                availableColumns={
                  terminalSize.columns - 4 - (sidebarVisible ? sidebarWidth : 0)
                }
                reservedForReply={state.session.completionMaxTokens}
              />
            ) : null}
            <ComposerSwitchPopup
              state={state}
              availableRows={switchPaneRows}
              availableColumns={
                terminalSize.columns - 4 - (sidebarVisible ? sidebarWidth : 0)
              }
              onActivate={activateComposerSwitch}
            />
            {state.menuOpen ? (
              <MenuPopup
                state={state}
                availableRows={menuPaneRows}
                availableColumns={
                  terminalSize.columns - 4 - (sidebarVisible ? sidebarWidth : 0)
                }
                onActivate={activateMenuNode}
              />
            ) : null}
          </Box>
          {state.pendingApproval ? (
            <Box flexShrink={0}>
              <ApprovalModal
                request={state.pendingApproval}
                pathDraft={state.approvalPathDraft}
                onPathOpen={onApprovalPathOpen}
                onPathChange={(value) =>
                  dispatch({ type: "approval_path_edit_changed", value })
                }
                onPathSubmit={onApprovalPathSubmit}
                onPathCancel={() =>
                  dispatch({ type: "approval_path_edit_closed" })
                }
              />
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
          {composerVisible ? (
            <>
              <QueuedMessages
                queued={state.queuedMessages}
                width={mainColumnWidth}
              />
              <PromptShell
            value={state.inputValue}
            placeholder="Type a message or `/` for commands…"
            rotatingPlaceholders={PROMPT_PLACEHOLDERS}
            backend={promptBackend}
            model={promptLlm.model}
            provider={promptLlm.provider}
            leftSlot={promptLeftSlot}
            rightSlot={promptRightSlot}
            contextSlot={promptContextSlot}
            focus={editorFocus}
            disabled={!canTypeMessage(state)}
            claimKey={composerClaimKey}
            onChange={onEditorChange}
            onSubmit={submit}
            onEscape={onEscape}
            onTab={onTab}
            onAutocomplete={onTab}
                onClickFocus={focusEditorFromClick}
                onSelectionChange={(hasSelection) =>
                  dispatch({
                    type: "composer_selection_changed",
                    hasSelection,
                  })
                }
                onCopy={(text) =>
                  dispatch({
                    type: "composer_notice",
                    text: `copied ${text.length} character${text.length === 1 ? "" : "s"}`,
                  })
                }
                onHistoryPrev={onHistoryPrev}
                onHistoryNext={onHistoryNext}
              />
            </>
          ) : null}
          <HotkeyHint
            state={state}
            ctrlCArmed={ctrlCArmed}
            menuLeaderArmed={menuLeaderArmed}
            width={mainColumnWidth}
          />
        </Box>
      </Box>
    </Box>
    </MouseProvider>
  );
}

