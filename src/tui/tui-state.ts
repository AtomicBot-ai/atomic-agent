import type { ApprovalRequest } from "../approval/approval-gate.js";
import type {
  LatestResult,
  LoadedSkillBody,
  WorldSnapshot,
} from "../session/session-state.js";
import type { LogRecord } from "../tracing/structured-logger.js";
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
  createInitialProvidersPanelState,
  type ProvidersPanelState,
} from "./providers/providers-panel-state.js";
import {
  createInitialLlmPanelState,
  type LlmPanelState,
} from "./llm-panel/llm-panel-state.js";

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
  | "providers";

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

export interface TuiSessionInfo {
  sessionId: string | null;
  workingDir: string;
  llamaUrl: string;
  browserChannel: string;
  browserHeadless: boolean;
  approvalRequired: boolean;
  maxSteps: number;
  skillCount: number;
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
  loadedSkills: readonly LoadedSkillBody[];
  worldSnapshot: WorldSnapshot | null;
  latestResult: LatestResult | null;
  metrics: RollingMetrics;
  logs: LogRecord[];
  /** Top-level UI mode (chat vs debug). */
  uiMode: TuiUiMode;
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
  /** Is the slash-command overlay currently visible below the editor? */
  slashPaletteOpen: boolean;
  /** Current slash prefix (characters typed after the leading `/`). */
  slashQuery: string;
  /** Highlighted row in the slash palette. */
  slashPaletteCursor: number;
  /** Which tool cards are shown expanded by the user. */
  toolsExpandedById: Readonly<Record<string, boolean>>;
  /** Is the session picker overlay visible? */
  sessionPickerOpen: boolean;
  /** Entries shown in the picker, newest first. */
  sessionPickerList: readonly SessionPickerEntry[];
  /** Highlighted row in the picker. */
  sessionPickerCursor: number;
  /** User-initiated abort in flight. */
  aborting: boolean;
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
  /** Cloud / local LLM provider registry (hot-swap active text provider). */
  providersPanel: ProvidersPanelState;
  /** Unified operator LLM panel combining provider routing and local daemon state. */
  llmPanel: LlmPanelState;
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
}

/**
 * Derived selector: can the user submit a new chat message right now?
 * Used by both the input component (disable when busy) and the
 * orchestrator (reject submissions sent while a turn is still in flight).
 */
export function canAcceptMessage(state: TuiState): boolean {
  return state.status === "idle";
}

export const DEFAULT_RING_BUFFER_SIZE = 500;

export interface InitialTuiLayoutOptions {
  uiMode?: TuiUiMode;
  activeTab?: TuiTab;
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
    logs: [],
    uiMode: layout?.uiMode ?? "chat",
    activeTab,
    lastRunStatus: null,
    runHistory: [],
    inputValue: "",
    inputHistory: [],
    inputHistoryCursor: null,
    slashPaletteOpen: false,
    slashQuery: "",
    slashPaletteCursor: 0,
    toolsExpandedById: {},
    sessionPickerOpen: false,
    sessionPickerList: [],
    sessionPickerCursor: 0,
    aborting: false,
    ringBufferSize,
    tasksPanel: createInitialTasksPanelState(),
    skillsPanel: createInitialSkillsPanelState(),
    memoryPanel: createInitialMemoryPanelState(),
    mcpPanel: createInitialMcpPanelState(),
    providersPanel: createInitialProvidersPanelState(),
    llmPanel,
    localModelsPanel: createInitialLocalModelsPanelState(),
    localLlmLogs: createInitialLocalLlmLogsState(),
    llmHealth: createInitialLlmHealthState(),
    telegramPanel: createInitialTelegramPanelState(),
    recentSessions: [],
    chatFocus: "editor",
    sidebarSection: "sessions",
    sidebarCursor: 0,
    sidebarTasksCursor: 0,
    chatScrollOffset: 0,
  };
}
