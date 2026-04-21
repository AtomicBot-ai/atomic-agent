import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { MetricSample } from "../telemetry/metrics-collector.js";
import type { LogRecord } from "../telemetry/structured-logger.js";
import { formatFeedLine } from "./format-event.js";
import type {
  ChatMessage,
  FeedEntry,
  ReasoningEntry,
  RunHistoryEntry,
  RunOutcome,
  TuiState,
  TuiTab,
} from "./tui-state.js";

/**
 * Every action the reducer knows how to fold into `TuiState`. All side
 * effects (abort controller, approval gate) stay outside — the reducer is
 * pure so it is unit-testable and deterministic under replay.
 */
export type TuiAction =
  | { type: "runtime_info"; line: string }
  | { type: "agent_event"; event: AgentLoopEvent }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string; approved: boolean }
  | { type: "metric"; sample: MetricSample }
  | { type: "log"; record: LogRecord }
  | { type: "skill_count_changed"; count: number }
  | { type: "session_created"; sessionId: string }
  | { type: "tab_changed"; tab: TuiTab }
  | { type: "abort_requested" }
  | { type: "input_changed"; value: string }
  /**
   * Orchestrator acknowledges a chat message submission: we wipe step/feed
   * state for the new turn, keep history and metrics cumulative, and flip
   * to running. The orchestrator is responsible for actually starting the
   * agent turn outside the reducer.
   */
  | { type: "message_submitted"; message: string }
  | { type: "quit_requested" }
  | { type: "loaded_skill"; skill: { name: string; version: string; body: string; loadedAt: number } }
  | { type: "world_snapshot"; snapshot: { kind: "browser" | "none"; digest: string; text: string; capturedAt: number } }
  | { type: "latest_result"; result: { tool: string; status: "ok" | "error"; summary: string; details?: Record<string, unknown> } };

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "runtime_info":
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: null,
        line: action.line,
        color: "cyan",
      });
    case "session_created":
      return { ...state, session: { ...state.session, sessionId: action.sessionId } };
    case "skill_count_changed":
      return { ...state, session: { ...state.session, skillCount: action.count } };
    case "agent_event":
      return reduceAgentEvent(state, action.event);
    case "approval_requested":
      return {
        ...state,
        status: "awaiting_approval",
        pendingApproval: action.request,
      };
    case "approval_resolved":
      if (state.pendingApproval?.approvalId !== action.approvalId) return state;
      return {
        ...state,
        pendingApproval: null,
        status: "running",
      };
    case "metric":
      return applyMetric(state, action.sample);
    case "log":
      return appendLog(state, action.record);
    case "tab_changed":
      return { ...state, activeTab: action.tab };
    case "abort_requested":
      return { ...state, aborting: true };
    case "input_changed":
      return { ...state, inputValue: action.value };
    case "message_submitted":
      return startNewRun(state);
    case "quit_requested":
      return { ...state, status: "quitting", aborting: true };
    case "loaded_skill": {
      const others = state.loadedSkills.filter((s) => s.name !== action.skill.name);
      return { ...state, loadedSkills: [...others, action.skill] };
    }
    case "world_snapshot":
      return { ...state, worldSnapshot: action.snapshot };
    case "latest_result":
      return { ...state, latestResult: action.result };
    default:
      return state;
  }
}

function reduceAgentEvent(state: TuiState, event: AgentLoopEvent): TuiState {
  switch (event.type) {
    case "user_message":
      return appendChatMessage(state, {
        role: "user",
        text: event.text,
      });
    case "turn_started":
      return {
        ...state,
        status: "running",
        currentTurnToolSteps: 0,
        runStartedAt: Date.now(),
      };
    case "turn_finished":
      return finishTurn(state, event.reason, event.stepCount);
    case "step_started":
      return {
        ...appendFeed(state, {
          kind: "step_started",
          stepIndex: event.stepIndex,
          line: formatFeedLine({ type: "step_started", stepIndex: event.stepIndex }),
          color: "cyan",
        }),
        status: "running",
        currentStep: event.stepIndex,
        stepStartedAt: Date.now(),
      };
    case "step_finished":
      return {
        ...appendFeed(state, {
          kind: "step_finished",
          stepIndex: event.stepIndex,
          line: formatFeedLine({
            type: "step_finished",
            stepIndex: event.stepIndex,
            summary: event.summary,
            durationMs: event.durationMs,
          }),
          color: "gray",
        }),
        stepStartedAt: null,
        metrics: { ...state.metrics, stepDurationMsLast: event.durationMs },
      };
    case "llm_event":
      return reduceStepEvent(state, event.event);
    case "loop_completed": {
      const outcome: RunOutcome = event.reason === "cancelled" ? "cancelled" : "completed";
      const lastRunStatus = `completed: ${event.reason}`;
      return finishRun(
        appendFeed(state, {
          kind: "loop_completed",
          stepIndex: null,
          line: `» ${lastRunStatus}`,
          color: event.reason === "cancelled" ? "yellow" : "green",
        }),
        { outcome, reason: event.reason, lastRunStatus },
      );
    }
    case "loop_failed": {
      const lastRunStatus = `failed: ${event.error.message}`;
      return finishRun(
        appendFeed(state, {
          kind: "loop_failed",
          stepIndex: null,
          line: `» ${lastRunStatus}`,
          color: "red",
        }),
        { outcome: "failed", reason: event.error.message, lastRunStatus },
      );
    }
    default:
      return state;
  }
}

function reduceStepEvent(
  state: TuiState,
  event: Extract<AgentLoopEvent, { type: "llm_event" }>["event"],
): TuiState {
  switch (event.type) {
    case "reasoning":
      return appendReasoning(state, {
        stepIndex: event.stepIndex,
        text: event.text,
      });
    case "tool_call_parsed":
      return appendFeed(state, {
        kind: "tool_call_parsed",
        stepIndex: state.currentStep,
        line: formatFeedLine({
          type: "tool_call_parsed",
          tool: event.call.tool,
          args: event.call.args,
        }),
        color: "magenta",
      });
    case "tool_call_executed": {
      const color = event.result.status === "ok" ? "green" : "red";
      const toolsOk = state.metrics.toolsOk + (event.result.status === "ok" ? 1 : 0);
      const toolsError = state.metrics.toolsError + (event.result.status === "error" ? 1 : 0);
      const isReply = event.result.tool === "reply";
      return {
        ...appendFeed(state, {
          kind: "tool_call_executed",
          stepIndex: state.currentStep,
          line: formatFeedLine({
            type: "tool_call_executed",
            tool: event.result.tool,
            status: event.result.status,
            summary: event.result.summary,
            truncated: event.result.truncated ?? false,
          }),
          color,
        }),
        latestResult: {
          tool: event.result.tool,
          status: event.result.status,
          summary: event.result.summary,
          ...(event.result.details !== undefined ? { details: event.result.details } : {}),
        },
        metrics: { ...state.metrics, toolsOk, toolsError },
        currentTurnToolSteps: isReply
          ? state.currentTurnToolSteps
          : state.currentTurnToolSteps + 1,
      };
    }
    case "assistant_reply":
      return appendChatMessage(state, {
        role: "assistant",
        text: event.text,
        toolSteps: state.currentTurnToolSteps,
      });
    case "step_error":
      return appendFeed(state, {
        kind: "step_error",
        stepIndex: state.currentStep,
        line: `  ! ${event.error.message}`,
        color: "red",
      });
    default:
      return state;
  }
}

function applyMetric(state: TuiState, sample: MetricSample): TuiState {
  switch (sample.name) {
    case "llm.prompt_tokens":
      return {
        ...state,
        metrics: {
          ...state.metrics,
          promptTokensLast: sample.value,
          totalTokens: state.metrics.totalTokens + sample.value,
        },
      };
    case "llm.completion_tokens":
      return {
        ...state,
        metrics: {
          ...state.metrics,
          completionTokensLast: sample.value,
          totalTokens: state.metrics.totalTokens + sample.value,
        },
      };
    case "llm.duration_ms":
      return {
        ...state,
        metrics: { ...state.metrics, llmDurationMsLast: sample.value },
      };
    case "llm.cache_reused": {
      const hit = sample.value === 1;
      return {
        ...state,
        metrics: {
          ...state.metrics,
          kvCacheHits: state.metrics.kvCacheHits + (hit ? 1 : 0),
          kvCacheMisses: state.metrics.kvCacheMisses + (hit ? 0 : 1),
        },
      };
    }
    default:
      return state;
  }
}

function appendFeed(state: TuiState, entry: Omit<FeedEntry, "id" | "timestamp">): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.feed.length}`;
  const next: FeedEntry = { id, timestamp, ...entry };
  const feed = state.feed.length >= state.ringBufferSize
    ? [...state.feed.slice(state.feed.length - state.ringBufferSize + 1), next]
    : [...state.feed, next];
  return { ...state, feed };
}

function appendReasoning(
  state: TuiState,
  entry: Omit<ReasoningEntry, "id" | "timestamp">,
): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.reasoning.length}`;
  const next: ReasoningEntry = { id, timestamp, ...entry };
  const reasoning = state.reasoning.length >= state.ringBufferSize
    ? [...state.reasoning.slice(state.reasoning.length - state.ringBufferSize + 1), next]
    : [...state.reasoning, next];
  return { ...state, reasoning };
}

function appendLog(state: TuiState, record: LogRecord): TuiState {
  const logs = state.logs.length >= state.ringBufferSize
    ? [...state.logs.slice(state.logs.length - state.ringBufferSize + 1), record]
    : [...state.logs, record];
  return { ...state, logs };
}

/**
 * Reset per-turn UI state when the user submits a new chat message. We
 * intentionally keep cumulative `runHistory` and `logs`, but wipe the
 * feed, current step counter, approval banner and the last-run status
 * line so the screen is clean for the new turn. Per-turn metrics
 * (`promptTokensLast`, `stepDurationMsLast`, …) are reset too; cumulative
 * counters (`totalTokens`, `kvCacheHits`) persist.
 */
function startNewRun(state: TuiState): TuiState {
  const now = Date.now();
  return {
    ...state,
    status: "running",
    currentStep: 0,
    stepStartedAt: null,
    runStartedAt: now,
    feed: [],
    reasoning: [],
    currentTurnToolSteps: 0,
    pendingApproval: null,
    metrics: {
      ...state.metrics,
      promptTokensLast: null,
      completionTokensLast: null,
      llmDurationMsLast: null,
      stepDurationMsLast: null,
    },
    lastRunStatus: null,
    inputValue: "",
    aborting: false,
  };
}

function appendChatMessage(
  state: TuiState,
  entry: Omit<ChatMessage, "id" | "timestamp">,
): TuiState {
  const timestamp = Date.now();
  const id = `${timestamp}-${state.messages.length}`;
  const next: ChatMessage = { id, timestamp, ...entry };
  const messages = state.messages.length >= state.ringBufferSize
    ? [...state.messages.slice(state.messages.length - state.ringBufferSize + 1), next]
    : [...state.messages, next];
  return { ...state, messages };
}

function lastUserMessage(state: TuiState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.messages[i];
    if (msg?.role === "user") return msg.text;
  }
  return "";
}

function finishTurn(
  state: TuiState,
  reason: string,
  stepCount: number,
): TuiState {
  const lastRunStatus = `turn ${reason}`;
  const outcome: RunOutcome =
    reason === "cancelled" || reason === "failed"
      ? reason === "failed"
        ? "failed"
        : "cancelled"
      : "completed";
  const entry: RunHistoryEntry = {
    message: lastUserMessage(state),
    outcome,
    reason,
    stepCount,
    durationMs: state.runStartedAt ? Date.now() - state.runStartedAt : 0,
    finishedAt: Date.now(),
  };
  const history = state.runHistory.length >= state.ringBufferSize
    ? [...state.runHistory.slice(state.runHistory.length - state.ringBufferSize + 1), entry]
    : [...state.runHistory, entry];
  return {
    ...state,
    status: "idle",
    runStartedAt: null,
    stepStartedAt: null,
    aborting: false,
    lastRunStatus,
    runHistory: history,
    currentTurnToolSteps: 0,
  };
}

function finishRun(
  state: TuiState,
  params: { outcome: RunOutcome; reason: string; lastRunStatus: string },
): TuiState {
  const entry: RunHistoryEntry = {
    message: lastUserMessage(state),
    outcome: params.outcome,
    reason: params.reason,
    stepCount: state.currentStep + 1,
    durationMs: state.runStartedAt ? Date.now() - state.runStartedAt : 0,
    finishedAt: Date.now(),
  };
  const history = state.runHistory.length >= state.ringBufferSize
    ? [...state.runHistory.slice(state.runHistory.length - state.ringBufferSize + 1), entry]
    : [...state.runHistory, entry];
  return {
    ...state,
    status: "idle",
    runStartedAt: null,
    stepStartedAt: null,
    aborting: false,
    lastRunStatus: params.lastRunStatus,
    runHistory: history,
  };
}
