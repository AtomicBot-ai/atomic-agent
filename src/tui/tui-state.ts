import type { ApprovalRequest } from "../approval/approval-gate.js";
import type {
  LatestResult,
  LoadedSkillBody,
  WorldSnapshot,
} from "../session/session-state.js";
import type { LogRecord } from "../telemetry/structured-logger.js";

/**
 * High-level lifecycle of the TUI. Mirrors the underlying `SessionState`
 * but stays independent: we cannot rely on the session store fine-grained
 * enough to drive the UI frame-by-frame, the reducer derives these states
 * from the `AgentLoopEvent` stream instead.
 */
/**
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

export type TuiTab = "chat" | "feed" | "world" | "reasoning" | "logs";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Number of tool steps the assistant ran inside this turn. */
  toolSteps?: number;
  timestamp: number;
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
  color: "green" | "red" | "yellow" | "cyan" | "gray" | "magenta" | "white";
  timestamp: number;
}

export interface RollingMetrics {
  promptTokensLast: number | null;
  completionTokensLast: number | null;
  llmDurationMsLast: number | null;
  stepDurationMsLast: number | null;
  kvCacheHits: number;
  kvCacheMisses: number;
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
  /** Per-run list of `<think>` blocks. Cleared on `goal_submitted`. */
  reasoning: ReasoningEntry[];
  pendingApproval: ApprovalRequest | null;
  loadedSkills: readonly LoadedSkillBody[];
  worldSnapshot: WorldSnapshot | null;
  latestResult: LatestResult | null;
  metrics: RollingMetrics;
  logs: LogRecord[];
  activeTab: TuiTab;
  /** Status line text for the last finished run, e.g. "completed: finish". */
  lastRunStatus: string | null;
  /** History of finished runs in chat-mode; newest last. */
  runHistory: RunHistoryEntry[];
  /** Current value of the goal input field. */
  inputValue: string;
  /** User-initiated abort in flight. */
  aborting: boolean;
  /** Max feed/log/history ring-buffer size — protects against runaway memory. */
  ringBufferSize: number;
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

export function createInitialTuiState(
  session: TuiSessionInfo,
  ringBufferSize: number = DEFAULT_RING_BUFFER_SIZE,
): TuiState {
  return {
    session,
    status: "idle",
    currentStep: 0,
    stepStartedAt: null,
    runStartedAt: null,
    feed: [],
    messages: [],
    currentTurnToolSteps: 0,
    reasoning: [],
    pendingApproval: null,
    loadedSkills: [],
    worldSnapshot: null,
    latestResult: null,
    metrics: {
      promptTokensLast: null,
      completionTokensLast: null,
      llmDurationMsLast: null,
      stepDurationMsLast: null,
      kvCacheHits: 0,
      kvCacheMisses: 0,
      totalTokens: 0,
      toolsOk: 0,
      toolsError: 0,
    },
    logs: [],
    activeTab: "chat",
    lastRunStatus: null,
    runHistory: [],
    inputValue: "",
    aborting: false,
    ringBufferSize,
  };
}
