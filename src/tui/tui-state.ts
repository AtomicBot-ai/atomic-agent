import {
  clampApprovalLevel,
  type ApprovalLevel,
} from "../approval/approval-level.js";
import type { CodingMode } from "./coding-mode.js";
import { EMPTY_CONTEXT_USAGE } from "./context-usage-from-prompt.js";
import type { ContextUsageState } from "../session/context-usage.js";
import type { ComposerSwitchState } from "./composer-switch/composer-switch-state.js";
import type { ContextMenuState } from "./context-menu/context-menu-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { WhileBusySubmitMode } from "../config/index.js";
import type { OnboardingUiState } from "./onboarding/onboarding-state.js";
import type {
  LatestResult,
  LoadedSkillBody,
  WorldSnapshot,
} from "../session/session-state.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import { getActiveThemeName } from "./theme/theme.js";
import {
  createInitialLlmHealthState,
  type LlmHealthState,
} from "./llm-health/llm-health-state.js";
import {
  createInitialLocalLlmLogsState,
  type LocalLlmLogsState,
} from "./local-models/local-llm-logs-state.js";
import {
  createInitialLocalModelsPanelState,
  type LocalModelsPanelSeed,
  type LocalModelsPanelState,
} from "./local-models/local-models-panel-state.js";
import {
  createInitialTasksPanelState,
  type TasksPanelState,
} from "./tasks/tasks-panel-state.js";
import {
  createInitialSkillsPanelState,
  type SkillsPanelState,
} from "./skills/skills-panel-state.js";
import {
  createInitialTelegramPanelState,
  type TelegramPanelState,
} from "./telegram/telegram-panel-state.js";
import {
  createInitialMemoryPanelState,
  type MemoryPanelState,
} from "./memory/memory-panel-state.js";
import {
  createInitialMcpPanelState,
  type McpPanelState,
} from "./mcp/mcp-panel-state.js";
import {
  createInitialImportPanelState,
  type ImportPanelState,
} from "./import/import-panel-state.js";
import {
  createInitialPrivacyPanelState,
  type PrivacyPanelState,
} from "./privacy/privacy-panel-state.js";
import {
  createInitialProvidersPanelState,
  type ProvidersPanelState,
} from "./providers/providers-panel-state.js";
import {
  createInitialLlmPanelState,
  type LlmPanelState,
} from "./llm-panel/llm-panel-state.js";
import {
  createInitialFallbackPanelState,
  type FallbackPanelState,
} from "./llm-panel/fallback/fallback-panel-state.js";
import type { UninstallFlowState } from "./uninstall/uninstall-state.js";

/**
 * High-level lifecycle of the TUI. Mirrors the underlying `SessionState`
 * but stays independent: we cannot rely on the session store fine-grained
 * enough to drive the UI frame-by-frame, the reducer derives these states
 * from the `AgentLoopEvent` stream instead.
 *
 * In chat-like mode the loop returns to `idle` after every run so a new
 * goal can be submitted without restarting the process. `completed`,
 * `failed` and `cancelled` describe the **last finished run** that is
 * recorded in `runHistory`; the live status is always one of
 * `idle | running | awaiting_approval`.
 */
export type TuiStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "quitting";

export type RunOutcome = "completed" | "failed" | "cancelled";

export interface RunHistoryEntry {
  /** First user message that drove this turn. */
  message: string;
  outcome: RunOutcome;
  reason: string;
  stepCount: number;
  durationMs: number;
  finishedAt: number;
}

/** Debug-pane inner tabs. In chat mode the debug pane is hidden entirely. */
export type TuiTab =
  | "feed"
  | "world"
  | "reasoning"
  | "logs"
  | "tasks"
  | "skills"
  | "memory"
  | "llm"
  | "models"
  | "llm-logs"
  | "telegram"
  | "mcp"
  | "providers"
  | "import"
  | "privacy";

/**
 * Top-level UI mode: `chat` is the default single-scroll openclaw-style
 * surface; `debug` swaps the middle pane for a tabbed view of the
 * historical debug panels (logs, metrics, trace). Header/status/footer/editor are identical
 * in both modes so context never jumps.
 */
export type TuiUiMode = "chat" | "debug";

export type ChatMessageVariant = "normal" | "warn";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** `warn` — failure / runtime error styling in {@link SystemBubble}. */
  variant?: ChatMessageVariant;
  /**
   * A user prompt this notice offers to re-run. Set on the system
   * notice a user-initiated abort leaves in the chat: the stop was one
   * click, so undoing a mistaken one should be too. `chat-log.tsx`
   * renders a `[try again]` beside `[copy]` that resubmits THIS text —
   * the aborted turn's user message — never the notice's own text.
   */
  retryText?: string;
  /** Number of tool steps the assistant ran inside this turn. */
  toolSteps?: number;
  /** Tool cards (call + result) attached to this assistant turn. */
  toolCards?: readonly ToolCardEntry[];
  /** Reasoning blocks captured during this assistant turn. */
  reasoningBlocks?: readonly string[];
  timestamp: number;
}

/**
 * A finalised tool-call bubble attached to an assistant message. The
 * reducer assembles these from the paired `tool_call_parsed` +
 * `tool_call_executed` events as they arrive inside a single run.
 */
export interface ToolCardEntry {
  id: string;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
  status: "pending" | "ok" | "error";
  summary: string;
  truncated: boolean;
  details?: Record<string, unknown>;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Tool call still in flight inside the current running turn. Upgraded to
 * a `ToolCardEntry` on `tool_call_executed` and then attached to the
 * finalised assistant `ChatMessage`.
 */
export interface StreamingToolCall {
  id: string;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
}

/**
 * A single `<think>` block emitted by the model at a given step. Collected
 * per-run (reset on `goal_submitted`) and capped by the same ring-buffer
 * budget as `feed` / `logs` to protect against long CoT traces.
 */
export interface ReasoningEntry {
  id: string;
  stepIndex: number;
  text: string;
  timestamp: number;
}

export type FeedEntryKind =
  | "step_started"
  | "tool_call_parsed"
  | "tool_call_executed"
  | "step_finished"
  | "step_error"
  | "loop_completed"
  | "loop_failed"
  | "runtime_info";

export interface FeedEntry {
  id: string;
  kind: FeedEntryKind;
  stepIndex: number | null;
  line: string;
  /** Ink `color` prop — controls the left gutter glyph colouring. */
  color: "green" | "red" | "yellow" | "blue" | "gray" | "magenta" | "white";
  timestamp: number;
}

export interface RollingMetrics {
  promptTokensLast: number | null;
  promptStablePrefixTokensLast: number | null;
  promptTailTokensLast: number | null;
  completionTokensLast: number | null;
  llmDurationMsLast: number | null;
  stepDurationMsLast: number | null;
  kvCacheHits: number;
  kvCacheMisses: number;
  parseRetries: number;
  totalTokens: number;
  toolsOk: number;
  toolsError: number;
}

/**
 * What the last built prompt actually put in the model's context window.
 *
 * Deliberately **not** part of `RollingMetrics`: those are reset at the
 * top of every turn (`startNewRun`), which is exactly wrong for a
 * readout that answers "how full is the window right now". The window
 * does not empty when you press Enter.
 *
 * The shape itself now lives in `src/session/context-usage.ts` — the
 * runtime persists the same snapshot on `SessionState` so a reopened
 * session can restore the gauge — and is re-exported here so TUI-side
 * importers keep their path.
 */
export type {
  ContextUsageState,
  ContextUsageSection,
} from "../session/context-usage.js";

export interface TuiSessionInfo {
  sessionId: string | null;
  workingDir: string;
  llamaUrl: string;
  browserChannel: string;
  browserHeadless: boolean;
  /** Live approval ladder position (1 = ask for everything … 5 = full trust). */
  approvalLevel: number;
  maxSteps: number;
  /**
   * Tokens the runtime holds back for the model's own reply
   * (`localModels.completionMaxTokens`). Not part of the prompt, but the
   * reason the prompt cannot grow into the last of the window — so the
   * context panel accounts for it separately from free space.
   */
  completionMaxTokens: number;
  skillCount: number;
  /**
   * Whether the user actually opted into a local backend (see
   * `isLocalBackendConfigured`). Decides whether the llama-server health
   * indicator is shown at all, so a fresh install is not told that a server
   * it never configured is down.
   */
  localBackendConfigured: boolean;
}

/**
 * Summary row for the session picker overlay. The TUI does not need the
 * full `SessionState` — it only displays id, cwd, counters and a short
 * preview of the first user message so operators can pick the thread
 * they want to resume.
 */
export interface SessionPickerEntry {
  sessionId: string;
  workingDir: string;
  turnCount: number;
  stepCount: number;
  updatedAt: number;
  /** First user message snippet (trimmed) or "(empty)" for blank sessions. */
  preview: string;
}

/**
 * The pending session deletion. `cursor` is the focused button, and it
 * starts on `cancel`: Enter on a dialog nobody read must not delete a
 * thread.
 */
export interface SessionDeleteConfirm {
  sessionId: string;
  preview: string;
  cursor: "yes" | "cancel";
}

export interface TuiState {
  session: TuiSessionInfo;
  status: TuiStatus;
  currentStep: number;
  stepStartedAt: number | null;
  /** Timestamp of the running loop start, used to compute a live duration. */
  runStartedAt: number | null;
  feed: FeedEntry[];
  /** Chat transcript: human-friendly view onto the session turn list. */
  messages: ChatMessage[];
  /** Counts tool steps inside the currently running turn. */
  currentTurnToolSteps: number;
  /**
   * Live assistant text for the turn in flight. When the LLM client emits
   * token deltas we accumulate them here; when none are available the
   * field stays `null` and the final message appears only on
   * `assistant_reply`. On turn finalisation the value is moved into
   * `messages` and reset back to `null`.
   */
  streamingAssistantText: string | null;
  /** Live tool calls for the current assistant turn. */
  streamingToolCalls: StreamingToolCall[];
  /** Finalised tool cards collected during the in-flight turn. */
  streamingToolCards: ToolCardEntry[];
  /** Per-run list of `<think>` blocks. Cleared on `goal_submitted`. */
  reasoning: ReasoningEntry[];
  pendingApproval: ApprovalRequest | null;
  /**
   * Live buffer of the approval prompt's target-path field, or `null`
   * when the field is closed. Non-null means that editor owns the
   * keyboard: the chat composer drops focus and the y / n hotkeys stand
   * down, so a path containing "y" cannot approve anything.
   */
  approvalPathDraft: string | null;
  /**
   * Whether the composer currently holds a text selection. Lifted out of
   * the editor for exactly one reason: Ctrl+C means "copy" while text is
   * selected and "stop / quit" otherwise, and the two handlers live in
   * different layers — the app's global key layer would arm the quit
   * chord before the editor ever saw the key.
   */
  composerHasSelection: boolean;
  /**
  /**
   * A short, transient line shown in the composer's meta row — "copied
   * 3 characters", and nothing heavier. It exists because the obvious
   * channels are both wrong for this: `runtime_info` appends to the
   * Observe feed, which nobody is looking at while they copy, and
   * `system_message` writes a chat entry, which would push the start
   * page off screen to acknowledge a keystroke.
   */
  composerNotice: string | null;
  /**
   * Open "delete the session?" confirmation, or `null`. Carries the
   * preview so the dialog can name what is about to go, and the focused
   * button so Enter has an unambiguous meaning.
   */
  sessionDelete: SessionDeleteConfirm | null;
  /**
   * The open uninstall ladder, or `null`. Deliberately a top-level slot
   * rather than a field on some panel: it is not part of any section,
   * and it outranks every other surface while it is up.
   */
  uninstall: UninstallFlowState | null;
  loadedSkills: readonly LoadedSkillBody[];
  worldSnapshot: WorldSnapshot | null;
  latestResult: LatestResult | null;
  metrics: RollingMetrics;
  /** Live context-window occupancy, driving the composer's context chip. */
  contextUsage: ContextUsageState;
  logs: LogRecord[];
  /** Top-level UI mode (chat vs debug). */
  uiMode: TuiUiMode;
  /**
   * First-run flow. Non-null means it owns the whole terminal — the app
   * chrome is not rendered behind it. `null` at every other moment.
   */
  onboarding: OnboardingUiState | null;
  /**
   * Active theme name. Stored so a runtime `/theme <name>` switch triggers a
   * re-render; the palette swap itself is done via `setActiveTheme`.
   */
  themeName: string;
  /** Inner tab of the debug pane; ignored in chat mode. */
  activeTab: TuiTab;
  /** Status line text for the last finished run, e.g. "completed: finish". */
  lastRunStatus: string | null;
  /** History of finished runs in chat-mode; newest last. */
  runHistory: RunHistoryEntry[];
  /** Current value of the editor buffer (may span multiple lines with `\n`). */
  inputValue: string;
  /**
   * Submitted messages in chronological order; used by Up/Down to recall
   * previous inputs. Capped by `ringBufferSize`.
   */
  inputHistory: string[];
  /**
   * Cursor into `inputHistory` when navigating. `null` means the editor
   * shows the live buffer; numbers are indices into `inputHistory` with
   * the newest entry at the end.
   */
  inputHistoryCursor: number | null;
  /**
   * The half-written draft that was in the editor when history recall
   * started, parked so Down can hand it back. `null` whenever the editor
   * is showing the live buffer — recall always stashes before it
   * overwrites, and any real edit to a recalled entry drops the stash.
   */
  inputHistoryDraft: string | null;
  /** Is the slash-command overlay currently visible below the editor? */
  slashPaletteOpen: boolean;
  /** Current slash prefix (characters typed after the leading `/`). */
  slashQuery: string;
  /** Highlighted row in the slash palette. */
  slashPaletteCursor: number;
  /**
   * Operator menu (Esc on an empty idle prompt) — the browsable half of
   * the navigation surface.
   * `menuPath` is the id of the submenu currently open, or `null` at the
   * root; the tree is one level deep by construction so a single id is
   * enough. A non-empty `menuQuery` flattens the tree: search ranks across
   * every node regardless of where it lives.
   */
  menuOpen: boolean;
  /** The composer's context detail panel floats over the chat. */
  contextPanelOpen: boolean;
  /**
   * Task count the operator is trying out in the open panel, before
   * committing it. `null` means the panel is reporting what the last
   * prompt actually did.
   *
   * A draft rather than a live config write: the whole point is to see
   * what a different limit would cost before choosing it, and writing on
   * every keypress would rebuild the budget under the cursor.
   */
  contextPanelPairsDraft: number | null;
  /**
   * Which of the composer meta row's three controls has its switch open
   * (backend kind / provider / model), and where its cursor sits.
   * `null` when the row is just a label, which is most of the time.
   */
  composerSwitch: ComposerSwitchState | null;
  /**
   * The right-click cut/copy/paste menu: the clicked cell and what it
   * targets, or `null`. Deliberately NOT part of `modalOwnsInput` — the
   * menu has its own registry floor (`MOUSE_LAYER_CONTEXT_MENU`) so the
   * composer keeps its viewport, and with it the anchor cell, while the
   * menu is up. The verbs themselves live outside the reducer, parked
   * on the `ContextMenuProvider` handle by whichever surface opened it.
   */
  contextMenu: ContextMenuState | null;
  menuPath: string | null;
  menuQuery: string;
  menuCursor: number;
  /** Which tool cards are shown expanded by the user. */
  toolsExpandedById: Readonly<Record<string, boolean>>;
  /** Is the session picker overlay visible? */
  sessionPickerOpen: boolean;
  /** Entries shown in the picker, newest first. */
  sessionPickerList: readonly SessionPickerEntry[];
  /** Highlighted row in the picker. */
  sessionPickerCursor: number;
  /** Theme picker overlay open (interactive `/theme` selection). */
  themePickerOpen: boolean;
  /** Highlighted row in the theme picker (index into `THEME_NAMES`). */
  themePickerCursor: number;
  /**
   * Theme name active when the picker was opened. Used to revert the
   * live-preview swap on Esc (cancel). Empty string when no picker session.
   */
  themePickerOriginal: string;
  /** User-initiated abort in flight. */
  aborting: boolean;
  /**
   * Pending self-update offer surfaced at startup when GitHub Releases
   * report a newer version. `null` when no update is offered (or the
   * offer was dismissed / accepted). Drives the {@link UpdateModal}.
   */
  updatePrompt: { current: string; latest: string } | null;
  /**
   * Persistent "a newer release exists" fact behind the status-bar
   * banner. Set alongside {@link updatePrompt} and — unlike the prompt —
   * NOT cleared by `update_dismissed`: skipping the modal means "not
   * now", and the banner is what keeps the offer reachable afterwards.
   * The bar hides it while an update is running or finished
   * (`updateStatus`), so no reducer case ever needs to null it.
   */
  updateBanner: { current: string; latest: string } | null;
  /**
   * Lifecycle of an accepted self-update. `running` while `install.sh`
   * executes; `done` / `failed` after it settles. Purely informational —
   * the user must relaunch to pick up a `done` update.
   */
  updateStatus: "idle" | "running" | "done" | "failed";
  /** Max feed/log/history ring-buffer size — protects against runaway memory. */
  ringBufferSize: number;
  /** State slice driving the Tasks tab (Option 4 background autonomy UI). */
  tasksPanel: TasksPanelState;
  /** State slice driving the Skills tab (enable / disable + detail view). */
  skillsPanel: SkillsPanelState;
  /** State slice driving the Memory tab (read-only memory fabric inspection). */
  memoryPanel: MemoryPanelState;
  /** State slice driving the MCP tab (read-only MCP server / catalog inspection). */
  mcpPanel: McpPanelState;
  /** State slice driving the Import tab (one-shot Hermes -> atomic-agent migration). */
  importPanel: ImportPanelState;
  /** State slice driving the Privacy tab (data-egress preferences). */
  privacyPanel: PrivacyPanelState;
  /** Cloud / local LLM provider registry (hot-swap active text provider). */
  providersPanel: ProvidersPanelState;
  /** Unified operator LLM panel combining provider routing and local daemon state. */
  llmPanel: LlmPanelState;
  /** Mirror of the effective provider fallback chain (Fallback pane of the LLM tab). */
  fallbackPanel: FallbackPanelState;
  /** Managed llama.cpp catalog + download UI (daemon lifecycle stays CLI-only). */
  localModelsPanel: LocalModelsPanelState;
  /** Tail of `<dataDir>/llama-server.log` driving the "LLM logs" tab. */
  localLlmLogs: LocalLlmLogsState;
  /** Always-on llama-server `/health` probe result driving the footer indicator. */
  llmHealth: LlmHealthState;
  /** State slice driving the Telegram tab (slice-3B live-control UI). */
  telegramPanel: TelegramPanelState;
  /**
   * Recently-modified sessions surfaced in the always-on sidebar. Loaded
   * once at TUI mount and refreshed when a new session is created or
   * switched to. Distinct from `sessionPickerList` (which is the modal
   * overlay) — a sidebar consumer rendering a quiet, paginated list
   * does not want the picker's "open / closed" lifecycle.
   */
  recentSessions: readonly SessionPickerEntry[];
  /**
   * Which surface owns keyboard focus inside the chat layout: the
   * editor (default) or the sidebar's panes (Sessions / Tasks). Tab
   * cycles `editor → sidebar(sessions) → sidebar(tasks) → editor` when
   * the sidebar is visible; the active sidebar pane is tracked
   * independently in `sidebarSection`. The reducer never inspects
   * terminal width — visibility is computed at render time so the
   * focus state stays valid even when the sidebar is collapsed under
   * the width threshold (Tab simply has nothing to focus).
   */
  chatFocus: "editor" | "sidebar";
  /**
   * Which sidebar pane is the current Tab-cycle stop. Only meaningful
   * when `chatFocus === "sidebar"` (the highlight follows it), but kept
   * in state always so a Tab back into the sidebar lands on the same
   * pane the operator left.
   */
  sidebarSection: "sessions" | "tasks";
  /**
   * The operator's own choice to fold the rail away — the `«` control
   * on the rail, the `»` on the status bar, or `/sidebar`. Session-only,
   * never persisted, and independent of the terminal-size gate: render
   * time combines both (`!sidebarCollapsed && isSidebarVisible(...)`),
   * so a rail folded by hand stays folded through resizes, and the
   * restore control only appears when the terminal could actually seat
   * the rail again.
   */
  sidebarCollapsed: boolean;
  /**
   * Highlighted row in the sidebar's session list. `0` = newest session,
   * `recentSessions.length - 1` = oldest. Independent of
   * `sessionPickerCursor` so opening / closing the modal picker does not
   * disturb the sidebar selection.
   */
  sidebarCursor: number;
  /**
   * Highlighted row in the sidebar's tasks list. Bounded by the number
   * of rows produced by `selectSidebarTasks` at render time; the
   * reducer clamps against the global `tasksPanel.rows` cap (5) since
   * the sidebar selector is a pure projection of that snapshot.
   */
  sidebarTasksCursor: number;
  /**
   * Scrollback offset (in messages from the bottom) for the chat
   * surface. `0` means "stuck to the latest message"; a positive value
   * scrolls up so older messages appear at the bottom of the window.
   * Resets to `0` whenever a new turn starts so the operator never
   * loses sight of the freshest reply.
   */
  chatScrollOffset: number;
  /**
   * Messages the operator submitted while a turn was still running, in
   * submission order. Mirrors `ChatOrchestrator`'s internal queue — the
   * orchestrator is the source of truth and re-publishes the list via
   * `queue_changed` on every mutation; this slice exists so the prompt
   * can show what is parked without reaching into the orchestrator.
   */
  queuedMessages: readonly string[];
  /**
   * What Enter does while a turn is running: `steer` folds the message
   * into the turn in flight, `queue` parks it for the next one. Seeded
   * from `config.tui.whileBusySubmit` at mount and flipped in-app with
   * Ctrl+T (persisted). Irrelevant when idle — Enter always starts a
   * turn then.
   */
  whileBusyMode: WhileBusySubmitMode;
  /**
   * The stance the session is working in — see `coding-mode.ts`. Session
   * state, never persisted: `bypass` surviving a restart would be a
   * standing grant nobody remembers making.
   */
  codingMode: CodingMode;
  /**
   * The mode menu, or `null` when it is closed. `cursor` indexes
   * {@link CODING_MODES}.
   *
   * Clicking the chip used to advance the ring directly, which made the
   * one control that changes what the agent is allowed to do the only
   * control in the app with no confirmation and no explanation — two
   * stray clicks took you from `plan` to `auto` with nothing on
   * screen saying what either meant.
   */
  codingModeMenu: { readonly cursor: number } | null;
  /**
   * A plan is on screen and nothing has been done with it yet.
   *
   * Set when a turn completes in plan mode, cleared the moment the next
   * one starts or the mode changes. Plan mode otherwise ends in a dead
   * end: the agent has said what it would do and is forbidden from
   * doing any of it, and the app said nothing about the obvious next
   * step at the one moment it was obvious.
   */
  planHandoff: boolean;
  /**
   * The approval level the operator actually configured, so `default`
   * can restore it. Seeded from the boot level and moved by the Privacy
   * tab; the coding-mode chip reads it and never writes it.
   */
  baseApprovalLevel: ApprovalLevel;
}

/**
 * Derived selector: can a new turn start *right now*? Used by the
 * submit pipeline to decide between running the message immediately and
 * parking it behind the turn in flight.
 */
export function canAcceptMessage(state: TuiState): boolean {
  return state.status === "idle";
}

/**
 * Derived selector: may the operator put characters into the editor?
 *
 * Deliberately weaker than {@link canAcceptMessage}. The editor used to
 * be disabled for the whole duration of a turn, which meant a running
 * agent swallowed every keystroke — you could not even draft the next
 * message, let alone send it. Typing is now allowed whenever the app is
 * not tearing down; a submission made while busy is queued rather than
 * dropped (see `handleEditorSubmit`).
 */
export function canTypeMessage(state: TuiState): boolean {
  return state.status !== "quitting";
}

export const DEFAULT_RING_BUFFER_SIZE = 500;

export interface InitialTuiLayoutOptions {
  uiMode?: TuiUiMode;
  /** Seeded by `tui-command` when the first-run flow has to open. */
  onboarding?: OnboardingUiState | null;
  activeTab?: TuiTab;
  /** Seeds {@link TuiState.whileBusyMode} from the persisted user config. */
  whileBusyMode?: WhileBusySubmitMode;
  /**
   * Seeds the local-models slice's config-derived facts (mode + chosen
   * model), so the composer's route controls are right on the home
   * screen before the Models tab ever refreshes the slice.
   */
  localModels?: LocalModelsPanelSeed;
}

export function createInitialTuiState(
  session: TuiSessionInfo,
  ringBufferSize: number = DEFAULT_RING_BUFFER_SIZE,
  layout?: InitialTuiLayoutOptions,
): TuiState {
  const requestedTab = layout?.activeTab ?? "feed";
  const activeTab = requestedTab === "models" || requestedTab === "providers"
    ? "llm"
    : requestedTab;
  const llmPanel = createInitialLlmPanelState();
  if (requestedTab === "models") llmPanel.syncModeToActiveRoute = true;
  if (requestedTab === "providers") llmPanel.mode = "cloud";
  return {
    session,
    status: "idle",
    currentStep: 0,
    stepStartedAt: null,
    runStartedAt: null,
    feed: [],
    messages: [],
    currentTurnToolSteps: 0,
    streamingAssistantText: null,
    streamingToolCalls: [],
    streamingToolCards: [],
    reasoning: [],
    pendingApproval: null,
    approvalPathDraft: null,
    composerHasSelection: false,
    composerNotice: null,
    sessionDelete: null,
    uninstall: null,
    loadedSkills: [],
    worldSnapshot: null,
    latestResult: null,
    metrics: {
      promptTokensLast: null,
      promptStablePrefixTokensLast: null,
      promptTailTokensLast: null,
      completionTokensLast: null,
      llmDurationMsLast: null,
      stepDurationMsLast: null,
      kvCacheHits: 0,
      kvCacheMisses: 0,
      parseRetries: 0,
      totalTokens: 0,
      toolsOk: 0,
      toolsError: 0,
    },
    contextUsage: EMPTY_CONTEXT_USAGE,
    logs: [],
    uiMode: layout?.uiMode ?? "chat",
    onboarding: layout?.onboarding ?? null,
    themeName: getActiveThemeName(),
    activeTab,
    lastRunStatus: null,
    runHistory: [],
    inputValue: "",
    inputHistory: [],
    inputHistoryCursor: null,
    inputHistoryDraft: null,
    slashPaletteOpen: false,
    slashQuery: "",
    slashPaletteCursor: 0,
    menuOpen: false,
    contextPanelOpen: false,
    contextPanelPairsDraft: null,
    composerSwitch: null,
    contextMenu: null,
    menuPath: null,
    menuQuery: "",
    menuCursor: 0,
    toolsExpandedById: {},
    sessionPickerOpen: false,
    sessionPickerList: [],
    sessionPickerCursor: 0,
    themePickerOpen: false,
    themePickerCursor: 0,
    themePickerOriginal: "",
    aborting: false,
    updatePrompt: null,
    updateBanner: null,
    updateStatus: "idle",
    ringBufferSize,
    tasksPanel: createInitialTasksPanelState(),
    skillsPanel: createInitialSkillsPanelState(),
    memoryPanel: createInitialMemoryPanelState(),
    mcpPanel: createInitialMcpPanelState(),
    importPanel: createInitialImportPanelState(),
    privacyPanel: createInitialPrivacyPanelState(),
    providersPanel: createInitialProvidersPanelState(),
    llmPanel,
    fallbackPanel: createInitialFallbackPanelState(),
    localModelsPanel: createInitialLocalModelsPanelState(layout?.localModels),
    localLlmLogs: createInitialLocalLlmLogsState(),
    // Optional chaining on purpose: `session` is typed as required but tests
    // call this with nothing (test files are outside tsconfig's include), and
    // before this argument existed no field was read here, so a bare
    // `session.` would turn those callers into a crash.
    llmHealth: createInitialLlmHealthState(session?.localBackendConfigured),
    telegramPanel: createInitialTelegramPanelState(),
    recentSessions: [],
    chatFocus: "editor",
    sidebarSection: "sessions",
    sidebarCollapsed: false,
    sidebarCursor: 0,
    sidebarTasksCursor: 0,
    chatScrollOffset: 0,
    queuedMessages: [],
    whileBusyMode: layout?.whileBusyMode ?? "steer",
    codingMode: "default",
    codingModeMenu: null,
    planHandoff: false,
    // `session` is optional in practice: several reducer tests build a
    // state with no session info at all, and a seed that assumed one
    // would turn every one of them into a crash about a field they do
    // not care about. The strictest level is the right default when
    // nobody said.
    baseApprovalLevel: clampApprovalLevel(session?.approvalLevel ?? 1),
  };
}
