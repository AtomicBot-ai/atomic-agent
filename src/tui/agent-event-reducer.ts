import type { AgentLoopEvent } from "../agent/agent-loop.js";
import { formatAgentErrorForChat } from "./format-agent-error-for-chat.js";
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
import { reduceImportAction } from "./import/import-reducer.js";
import { reduceProvidersPanel } from "./providers/providers-reducer.js";
import { reduceLlmPanelAction } from "./llm-panel/llm-panel-reducer.js";
import { reduceFallbackPanelAction } from "./llm-panel/fallback/fallback-panel-reducer.js";
import { reduceTelegramAction } from "./telegram/telegram-panel-reducer.js";
import { reducePrivacyAction } from "./privacy/privacy-panel-reducer.js";
import { reduceRunModeAction } from "./run-mode/run-mode-reducer.js";
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
  const importHandled = reduceImportAction(state, action);
  if (importHandled !== null) return importHandled;
  const providersHandled = reduceProvidersPanel(state, action);
  if (providersHandled !== null) return providersHandled;
  const llmPanelHandled = reduceLlmPanelAction(state, action);
  if (llmPanelHandled !== null) return llmPanelHandled;
  const fallbackHandled = reduceFallbackPanelAction(state, action);
  if (fallbackHandled !== null) return fallbackHandled;
  const telegramHandled = reduceTelegramAction(state, action);
  if (telegramHandled !== null) return telegramHandled;
  const privacyHandled = reducePrivacyAction(state, action);
  if (privacyHandled !== null) return privacyHandled;
  const runModeHandled = reduceRunModeAction(state, action);
  if (runModeHandled !== null) return runModeHandled;
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
      return appendChatMessage(state, {
        role: "system",
        text: action.text,
        ...(action.variant ? { variant: action.variant } : {}),
      });
    case "session_created":
      return { ...state, session: { ...state.session, sessionId: action.sessionId } };
    case "skill_count_changed":
      return { ...state, session: { ...state.session, skillCount: action.count } };
    case "approval_level_changed":
      return {
        ...state,
        session: { ...state.session, approvalLevel: action.approvalLevel },
      };
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
      if (action.tab === "models") {
        return {
          ...state,
          activeTab: "llm",
          llmPanel: { ...state.llmPanel, mode: "local" },
        };
      }
      if (action.tab === "providers") {
        return {
          ...state,
          activeTab: "llm",
          llmPanel: { ...state.llmPanel, mode: "cloud" },
        };
      }
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
          // A server that answers is a server somebody meant to run, even if
          // config never said so. Latch it on so the indicator appears for
          // that user and survives the server later going down.
          localConfigured:
            state.llmHealth.localConfigured || action.status === "healthy",
        },
      };
    case "llm_model_updated":
      return {
        ...state,
        llmHealth: {
          ...state.llmHealth,
          model: action.model,
          // Only overwrite the context window when the update carries one
          // (an optimistic catalog-label update omits it — keep the last
          // known `/props` value instead of blanking the tray).
          contextWindow:
            action.contextWindow === undefined
              ? state.llmHealth.contextWindow
              : action.contextWindow,
        },
      };
    case "update_available":
      // Never override an in-flight or finished update with a new offer.
      if (state.updateStatus !== "idle") return state;
      return {
        ...state,
        updatePrompt: { current: action.current, latest: action.latest },
      };
    case "update_dismissed":
      return { ...state, updatePrompt: null };
    case "update_started":
      return appendFeed(
        { ...state, updatePrompt: null, updateStatus: "running" },
        {
          kind: "runtime_info",
          stepIndex: null,
          line: "[update] starting…",
          color: "yellow",
        },
      );
    case "update_finished": {
      const next: TuiState = {
        ...state,
        updateStatus: action.ok ? "done" : "failed",
      };
      return appendChatMessage(next, {
        role: "system",
        text: action.ok
          ? `updated to v${action.version ?? "?"} — press any key to restart`
          : `update failed: ${action.error ?? "unknown error"}`,
        variant: action.ok ? "normal" : "warn",
      });
    }
    default:
      return state;
  }
}

function reduceAgentEvent(state: TuiState, event: AgentLoopEvent): TuiState {
  switch (event.type) {
    case "user_message":
      return appendUserMessage(state, event.text);
    case "steer_applied":
      // Same bubble shape as any other user message: it *is* one, and
      // the agent loop recorded it as a real `user` turn. Rendering it
      // here (rather than optimistically at submit time) means a steer
      // that missed the turn and fell back to the queue appears exactly
      // once, when it actually reaches the model.
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
      const outcome: RunOutcome =
        event.reason === "cancelled"
          ? "cancelled"
          : event.reason === "failed"
            ? "failed"
            : "completed";
      const lastRunStatus =
        outcome === "completed"
          ? `completed: ${event.reason}`
          : `${outcome}: ${event.reason}`;
      const feedColor =
        event.reason === "cancelled"
          ? "yellow"
          : event.reason === "failed"
            ? "red"
            : "green";
      return finishRun(
        appendFeed(state, {
          kind: "loop_completed",
          stepIndex: null,
          line: `» ${lastRunStatus}`,
          color: feedColor,
        }),
        { outcome, reason: event.reason, lastRunStatus },
      );
    }
    case "provider_switched": {
      // The one live signal the Fallback pane has: the runtime breaker
      // instance is not reachable from the TUI, so we mirror the last
      // announced transition into `fallbackPanel.lastSwitch` (no invented
      // countdown) and drop a feed line so the switch is visible in the
      // stream too.
      const line =
        event.direction === "away"
          ? `» failed over ${event.from} -> ${event.to} (${event.reason})`
          : `» recovered primary ${event.to} (probe ok)`;
      return appendFeed(
        {
          ...state,
          fallbackPanel: {
            ...state.fallbackPanel,
            lastSwitch: {
              direction: event.direction,
              from: event.from,
              to: event.to,
              reason: event.reason,
            },
          },
        },
        {
          kind: "runtime_info",
          stepIndex: null,
          line,
          color: event.direction === "away" ? "yellow" : "green",
        },
      );
    }
    case "loop_failed": {
      const lastRunStatus = `failed [${event.category}]: ${event.error.message}`;
      const chatError = formatAgentErrorForChat(
        event.category,
        event.error.message,
      );
      return finishRun(
        appendChatMessage(
          appendFeed(state, {
            kind: "loop_failed",
            stepIndex: null,
            line: `» ${lastRunStatus}`,
            color: "red",
          }),
          { role: "system", text: chatError, variant: "warn" },
        ),
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
    case "step_routed": {
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: formatFeedLine({
          type: "step_routed",
          stepIndex: event.stepIndex,
          role: event.role,
          providerId: event.providerId,
          complexity: event.complexity,
          cloudShare: event.cloudShare,
        }),
        color: "blue",
      });
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
