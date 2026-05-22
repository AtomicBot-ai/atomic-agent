import type { AgentLoopEvent } from "../agent/agent-loop.js";
import { formatFeedLine } from "./format-event.js";
import {
  appendChatMessage,
  appendFeed,
  appendReasoningDelta,
  appendUserMessage,
  applyMetric,
  beginStreamingToolCall,
  finalizeStreamingToolCall,
  finishRun,
  finishTurn,
  pushRing,
  startNewRun,
  upsertReasoning,
} from "./reducer-helpers.js";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { reduceLocalModelsAction } from "./local-models/local-models-reducer.js";
import { reduceTasksAction } from "./tasks/tasks-reducer.js";
import { reduceSkillsAction } from "./skills/skills-reducer.js";
import { reduceMemoryAction } from "./memory/memory-reducer.js";
import { reduceMcpAction } from "./mcp/mcp-reducer.js";
import { reduceTelegramAction } from "./telegram/telegram-panel-reducer.js";
import type { TuiAction } from "./tui-action.js";
import type { RunOutcome, StreamingToolCall, TuiState } from "./tui-state.js";

export type { TuiAction } from "./tui-action.js";

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  const localModelsHandled = reduceLocalModelsAction(state, action);
  if (localModelsHandled !== null) return localModelsHandled;
  const tasksHandled = reduceTasksAction(state, action);
  if (tasksHandled !== null) return tasksHandled;
  const skillsHandled = reduceSkillsAction(state, action);
  if (skillsHandled !== null) return skillsHandled;
  const memoryHandled = reduceMemoryAction(state, action);
  if (memoryHandled !== null) return memoryHandled;
  const mcpHandled = reduceMcpAction(state, action);
  if (mcpHandled !== null) return mcpHandled;
  const telegramHandled = reduceTelegramAction(state, action);
  if (telegramHandled !== null) return telegramHandled;
  const uiHandled = reduceUiAction(state, action);
  if (uiHandled !== null) return uiHandled;
  switch (action.type) {
    case "runtime_info":
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: null,
        line: action.line,
        color: "blue",
      });
    case "system_message":
      return appendChatMessage(state, { role: "system", text: action.text });
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
      return { ...state, pendingApproval: null, status: "running" };
    case "metric":
      return applyMetric(state, action.sample);
    case "log":
      return { ...state, logs: pushRing(state.logs, action.record, state.ringBufferSize) };
    case "tab_changed":
      return { ...state, activeTab: action.tab };
    case "abort_requested":
      return { ...state, aborting: true };
    case "input_changed":
      return {
        ...state,
        inputValue: action.value,
        inputHistoryCursor: null,
      };
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
    case "assistant_delta":
      return {
        ...state,
        streamingAssistantText:
          (state.streamingAssistantText ?? "") + action.text,
      };
    case "llm_health_updated":
      return {
        ...state,
        llmHealth: {
          ...state.llmHealth,
          status: action.status,
          lastCheckedAt: action.checkedAt,
          latencyMs: action.latencyMs,
          error: action.error,
        },
      };
    case "llm_model_updated":
      return {
        ...state,
        llmHealth: { ...state.llmHealth, model: action.model },
      };
    default:
      return state;
  }
}

function reduceAgentEvent(state: TuiState, event: AgentLoopEvent): TuiState {
  switch (event.type) {
    case "user_message":
      return appendUserMessage(state, event.text);
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
          color: "blue",
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
      const lastRunStatus = `failed [${event.category}]: ${event.error.message}`;
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
      return upsertReasoning(state, {
        stepIndex: event.stepIndex,
        text: event.text,
      });
    case "reasoning_delta":
      return appendReasoningDelta(state, {
        stepIndex: event.stepIndex,
        text: event.text,
      });
    case "assistant_delta":
      return {
        ...state,
        streamingAssistantText:
          (state.streamingAssistantText ?? "") + event.text,
      };
    case "prompt_captured": {
      const withFeed = appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: formatFeedLine({
          type: "prompt_captured",
          stepIndex: event.stepIndex,
          total: event.tokens.total,
          stablePrefix: event.tokens.stablePrefix,
          tail: event.tokens.tail,
          cacheReused: event.cacheReused,
        }),
        color: event.cacheReused ? "green" : "yellow",
      });
      return {
        ...withFeed,
        metrics: {
          ...withFeed.metrics,
          promptTokensLast: event.tokens.total,
          promptStablePrefixTokensLast: event.tokens.stablePrefix,
          promptTailTokensLast: event.tokens.tail,
        },
      };
    }
    case "parse_retry": {
      const withFeed = appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: formatFeedLine({
          type: "parse_retry",
          stepIndex: event.stepIndex,
          attempt: event.attempt,
          reason: event.reason,
        }),
        color: "yellow",
      });
      return {
        ...withFeed,
        metrics: {
          ...withFeed.metrics,
          parseRetries: withFeed.metrics.parseRetries + 1,
        },
      };
    }
    case "tool_call_parsed": {
      const call: StreamingToolCall = {
        id: `tc-${Date.now()}-${state.streamingToolCalls.length}-${state.streamingToolCards.length}`,
        stepIndex: state.currentStep,
        tool: event.call.tool,
        args: event.call.args,
        startedAt: Date.now(),
      };
      return beginStreamingToolCall(
        appendFeed(state, {
          kind: "tool_call_parsed",
          stepIndex: state.currentStep,
          line: formatFeedLine({
            type: "tool_call_parsed",
            tool: event.call.tool,
            args: event.call.args,
            batchIndex: event.batchIndex,
            batchSize: event.batchSize,
          }),
          color: "magenta",
        }),
        call,
      );
    }
    case "tool_call_executed": {
      const color = event.result.status === "ok" ? "green" : "red";
      const toolsOk = state.metrics.toolsOk + (event.result.status === "ok" ? 1 : 0);
      const toolsError = state.metrics.toolsError + (event.result.status === "error" ? 1 : 0);
      const isReply = event.result.tool === "reply";
      const withFeed = appendFeed(state, {
        kind: "tool_call_executed",
        stepIndex: state.currentStep,
        line: formatFeedLine({
          type: "tool_call_executed",
          tool: event.result.tool,
          status: event.result.status,
          summary: event.result.summary,
          truncated: event.result.truncated ?? false,
          batchIndex: event.batchIndex,
          batchSize: event.batchSize,
        }),
        color,
      });
      const { state: withCard } = finalizeStreamingToolCall(withFeed, {
        tool: event.result.tool,
        status: event.result.status,
        summary: event.result.summary,
        truncated: event.result.truncated ?? false,
        ...(event.result.details !== undefined ? { details: event.result.details } : {}),
      });
      return {
        ...withCard,
        latestResult: {
          tool: event.result.tool,
          status: event.result.status,
          summary: event.result.summary,
          ...(event.result.details !== undefined ? { details: event.result.details } : {}),
        },
        metrics: { ...withCard.metrics, toolsOk, toolsError },
        currentTurnToolSteps: isReply
          ? state.currentTurnToolSteps
          : state.currentTurnToolSteps + 1,
      };
    }
    case "rare_tool_autoloaded":
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: formatFeedLine({
          type: "rare_tool_autoloaded",
          tool: event.tool,
        }),
        color: "yellow",
      });
    case "assistant_reply": {
      const reasoningForTurn = state.reasoning.map((r) => r.text);
      const toolCardsForTurn = state.streamingToolCards;
      const withMessage = appendChatMessage(state, {
        role: "assistant",
        text: event.text,
        toolSteps: state.currentTurnToolSteps,
        ...(toolCardsForTurn.length > 0 ? { toolCards: toolCardsForTurn } : {}),
        ...(reasoningForTurn.length > 0 ? { reasoningBlocks: reasoningForTurn } : {}),
      });
      // Clear live reasoning along with the other streaming state so the
      // StreamingTail does not re-expand reasoning the instant the turn
      // finalises — the reasoning now lives inside the finalised message
      // and is rendered collapsed next to it.
      return {
        ...withMessage,
        streamingAssistantText: null,
        streamingToolCalls: [],
        streamingToolCards: [],
        reasoning: [],
      };
    }
    case "step_error":
      return appendFeed(state, {
        kind: "step_error",
        stepIndex: state.currentStep,
        line: `  ! [${event.category}] ${event.error.message}`,
        color: "red",
      });
    default:
      return state;
  }
}
