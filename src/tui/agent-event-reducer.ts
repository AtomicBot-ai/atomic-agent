import type { AgentLoopEvent } from "../agent/agent-loop.js";
import {
  contextUsageFromPrompt,
  EMPTY_CONTEXT_USAGE,
} from "./context-usage-from-prompt.js";
import { formatBackgroundApprovalNotice } from "./detached-turns.js";
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
  finishRunWithoutHistory,
  finishTurn,
  pushRing,
  startNewRun,
  upsertReasoning,
} from "./reducer-helpers.js";
import { reduceUiAction } from "./reduce-ui-actions.js";
import { reduceComposerSwitchAction } from "./composer-switch/composer-switch-reducer.js";
import { selectComposerBackend } from "./composer-switch/composer-switch-rows.js";
import { reduceLocalModelsAction } from "./local-models/local-models-reducer.js";
import { reduceTasksAction } from "./tasks/tasks-reducer.js";
import { reduceSkillsAction } from "./skills/skills-reducer.js";
import { reduceMemoryAction } from "./memory/memory-reducer.js";
import { reduceMcpAction } from "./mcp/mcp-reducer.js";
import { reduceUninstallAction } from "./uninstall/uninstall-reducer.js";
import { reduceImportAction } from "./import/import-reducer.js";
import { reduceOnboardingAction } from "./onboarding/onboarding-reducer.js";
import { reduceProvidersPanel } from "./providers/providers-reducer.js";
import { reduceLlmPanelAction } from "./llm-panel/llm-panel-reducer.js";
import { reduceFallbackPanelAction } from "./llm-panel/fallback/fallback-panel-reducer.js";
import { reduceTelegramAction } from "./telegram/telegram-panel-reducer.js";
import { reducePrivacyAction } from "./privacy/privacy-panel-reducer.js";
import type { TuiAction } from "./tui-action.js";
import type { RunOutcome, StreamingToolCall, TuiState } from "./tui-state.js";

export type { TuiAction } from "./tui-action.js";

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  // First in the chain, and only ever claims an action while the
  // first-run flow is open. Several actions belong to two owners then —
  // a finished model pull, a saved provider — and the flow has to see
  // them to advance. A handled action never reaches the rest of the
  // chain, so it delegates the panel half to the owning slice rather
  // than duplicating it.
  const onboardingHandled = reduceOnboardingAction(state, action);
  if (onboardingHandled !== null) return onboardingHandled;
  const localModelsHandled = reduceLocalModelsAction(state, action);
  if (localModelsHandled !== null) return localModelsHandled;
  const tasksHandled = reduceTasksAction(state, action);
  if (tasksHandled !== null) return tasksHandled;
  const skillsHandled = reduceSkillsAction(state, action);
  if (skillsHandled !== null) return skillsHandled;
  const memoryHandled = reduceMemoryAction(state, action);
  if (memoryHandled !== null) return memoryHandled;
  const uninstallHandled = reduceUninstallAction(state, action);
  if (uninstallHandled !== null) return uninstallHandled;
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
  const composerSwitchHandled = reduceComposerSwitchAction(state, action);
  if (composerSwitchHandled !== null) return composerSwitchHandled;
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
      return {
        ...state,
        session: { ...state.session, sessionId: action.sessionId },
        // A different thread has a different window fill. Carrying the
        // old figure over would read as "this fresh session is already
        // 40% full" until the first prompt lands.
        contextUsage: EMPTY_CONTEXT_USAGE,
      };
    case "skill_count_changed":
      return { ...state, session: { ...state.session, skillCount: action.count } };
    case "approval_level_changed":
      return {
        ...state,
        session: { ...state.session, approvalLevel: action.approvalLevel },
      };
    case "agent_event":
      // Events from a turn running on a *different* session — one the
      // operator backgrounded by switching away, or a scheduler /
      // Telegram / HTTP turn — must not paint into the transcript on
      // screen (or flip `status`, which is what used to freeze the
      // composer). An untagged event was emitted outside a turn frame
      // (global notices) and passes through as before.
      if (
        action.sessionId !== undefined &&
        action.sessionId !== state.session.sessionId
      ) {
        return state;
      }
      return reduceAgentEvent(state, action.event);
    case "session_delete_requested":
      return {
        ...state,
        sessionDelete: {
          sessionId: action.sessionId,
          preview: action.preview,
          // Destructive default: the dialog opens on Cancel.
          cursor: "cancel",
        },
      };
    case "session_delete_cursor_set":
      if (!state.sessionDelete) return state;
      return {
        ...state,
        sessionDelete: { ...state.sessionDelete, cursor: action.cursor },
      };
    case "session_delete_closed":
      return { ...state, sessionDelete: null };
    case "approval_requested":
      // A request raised by a session that is NOT on screen must never
      // arm the modal: every approval key (and the prose-deny submit)
      // answers whatever `pendingApproval` holds, so parking a
      // background thread's question here would let a reflexive Ctrl+C
      // deny a tool call the operator cannot even see — and abort the
      // visible turn in the same press. The request stays pending at
      // the gate; the transcript gets a pointer naming the owner, and
      // `switchSession` re-raises the prompt once that owner is
      // visible.
      if (action.request.sessionId !== state.session.sessionId) {
        return appendChatMessage(state, {
          role: "system",
          text: formatBackgroundApprovalNotice(action.request),
          variant: "warn",
        });
      }
      return {
        ...state,
        status: "awaiting_approval",
        pendingApproval: action.request,
        // A redirect re-prompts for the new target; the previous
        // prompt's draft must not leak into it.
        approvalPathDraft: null,
      };
    case "approval_resolved":
      if (state.pendingApproval?.approvalId !== action.approvalId) return state;
      return {
        ...state,
        pendingApproval: null,
        approvalPathDraft: null,
        // Resolving the visible turn's request resumes that turn:
        // `running`. Resolving a background turn's request resumes a
        // turn this transcript is not showing — the visible status
        // (idle, or a run of its own) is left alone.
        status:
          state.pendingApproval.sessionId === state.session.sessionId
            ? "running"
            : state.status,
      };
    case "approval_path_edit_opened":
      if (!state.pendingApproval) return state;
      return { ...state, approvalPathDraft: action.path };
    case "approval_path_edit_changed":
      if (state.approvalPathDraft === null) return state;
      return { ...state, approvalPathDraft: action.value };
    case "approval_path_edit_closed":
      return { ...state, approvalPathDraft: null };
      return { ...state, pendingApproval: null, status: "running" };
    case "composer_notice":
      if (state.composerNotice === action.text) return state;
      return { ...state, composerNotice: action.text };
    case "composer_selection_changed":
      if (state.composerHasSelection === action.hasSelection) return state;
      return { ...state, composerHasSelection: action.hasSelection };
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
    case "input_changed": {
      // Moving the caret re-emits the buffer unchanged (the editor owns
      // the cursor and reports it through `onChange`). That is not an
      // edit, so it must not knock us out of history recall — otherwise
      // a single Left/Right after Up dropped the recall position and the
      // parked draft with it.
      if (action.value === state.inputValue) return state;
      return {
        ...state,
        inputValue: action.value,
        inputHistoryCursor: null,
        inputHistoryDraft: null,
      };
    }
    case "message_submitted":
      return startNewRun(state);
    case "turn_gate_blocked": {
      const withMessage = appendChatMessage(
        appendFeed(state, {
          kind: "runtime_info",
          stepIndex: null,
          line: `» blocked: ${action.text.split("\n")[0] ?? action.text}`,
          color: "yellow",
        }),
        { role: "system", text: action.text, variant: "warn" },
      );
      // A drained queue message is gated after the previous turn already
      // returned the app to idle — nothing to finish then. The fresh
      // submit path arrives here `running` (from `message_submitted`)
      // with no turn behind it, so the idle reset is what hands the
      // composer back — WITHOUT a run-history entry: the blocked text
      // never reached `state.messages`, so an entry would carry the
      // previous turn's message, and a refused submit is not a run.
      if (state.status !== "running") return withMessage;
      return finishRunWithoutHistory(
        withMessage,
        "blocked: local model not ready",
      );
    }
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
      // A message the operator sent mid-turn, folded into the prompt of
      // the step named here. It renders INLINE in the running turn: same
      // chat bubble as any user message, but none of the per-turn resets
      // `user_message` implies — no `startNewRun`, no step counter reset.
      // The feed line is what ties it to the step it actually reached.
      return appendUserMessage(
        appendFeed(state, {
          kind: "runtime_info",
          stepIndex: event.stepIndex,
          line: `» steering applied at step ${event.stepIndex}`,
          color: "yellow",
        }),
        event.text,
      );
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
        {
          // The same "is the chat route a llama-server" answer the
          // composer's backend control renders — KIND-based, so a
          // llama-server entry under a custom id still earns the hint;
          // only a `cloud` route must not (the hint names the llama
          // URL). Rows land at TUI start via the providers refresh.
          activeProviderIsLocal: selectComposerBackend(state) !== "cloud",
          llamaUrl: state.session.llamaUrl,
        },
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
    case "loop_detected":
      // Deliberately not rendered: the loop detector's own `### notice`
      // changes what the model does, and the operator sees the effect
      // through the tool calls that follow. Listed explicitly so the
      // exhaustiveness check below stays meaningful.
      return state;
    default: {
      // `steer_applied` shipped with a doc comment promising inline
      // rendering and no case here, and a bare `default: return state`
      // meant TypeScript had nothing to say about it. This makes the
      // next new `AgentLoopEvent` a compile error instead of a silent
      // no-op — while still returning `state` at runtime, because a UI
      // reducer must never throw on an event it does not know.
      const unhandled: never = event;
      void unhandled;
      return state;
    }
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
    case "batch_trimmed":
      // Surfaced by the exhaustiveness check below: the model asked for
      // `originalSize` calls and only one ran. That is worth a line —
      // otherwise the dropped calls reappear one-by-one next step with
      // no explanation for why the batch shrank.
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: `  ~ batch trimmed to ${event.kept} (${event.dropped.length} of ${event.originalSize} deferred: ${event.reason})`,
        color: "yellow",
      });
    case "batch_wave_split":
      // Issue #111: an oversized pure-read batch ran in bounded waves.
      // Nothing was dropped — every call executed — so the feed line
      // says so explicitly (otherwise the follow-up step's tool calls
      // look like a re-run of the same reads).
      return appendFeed(state, {
        kind: "runtime_info",
        stepIndex: event.stepIndex,
        line: `  ~ ${event.originalSize} reads split into ${event.waveCount} waves of ≤ ${event.cap} (nothing dropped)`,
        color: "yellow",
      });
    case "prompt_built":
      // The feed still ignores the prompt text itself — it would drown
      // the log — but the token breakdown that comes with it is the only
      // authoritative statement of what is in the window right now.
      return {
        ...state,
        contextUsage: contextUsageFromPrompt(event.prompt),
        // Reality has caught up with the selector: the prompt was built
        // against the number the operator chose, so the local override
        // is no longer telling anyone anything the measurement does not.
        // Cleared only on a match, because a build that predates the
        // change would otherwise snap the selector back to the old value
        // in front of them.
        contextPanelPairsDraft:
          state.contextPanelPairsDraft === event.prompt.conversationPairsCap
            ? null
            : state.contextPanelPairsDraft,
      };
    case "llm_completed": {
      // `prompt_built` carried an estimate (`estimateTokens` over-counts
      // by design); the provider just reported what its own tokenizer
      // actually counted — llama.cpp from `tokens_evaluated`, an
      // OpenAI-compatible cloud from `usage.prompt_tokens`. Prefer it,
      // and leave the estimate standing when nothing was reported.
      const counted = event.completion.timing?.promptTokens ?? 0;
      if (counted <= 0) return state;
      return {
        ...state,
        contextUsage: { ...state.contextUsage, tokens: counted },
      };
    }
    case "llm_raw_completion":
      // Raw plumbing: the whole completion object, the unparsed text.
      // The trace recorder wants them; the chat feed would drown in
      // them. Listed so the exhaustiveness check holds.
      return state;
    default: {
      const unhandled: never = event;
      void unhandled;
      return state;
    }
  }
}
