import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import {
  PLAIN_INSTRUCT_PROFILE,
  type ModelProfile,
} from "../llm/model-profile.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  CancelledError,
  LlmFailure,
  classifyFailure,
} from "../llm/index.js";
import type { LlmFailureCategory } from "../llm/index.js";
import type { SessionState } from "../session/session-state.js";
import {
  incrementTurnCount,
  recordTurn,
} from "../session/session-state.js";
import {
  assistantReplyTurn,
  userTurn,
} from "../session/conversation-turn.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import type { ProfileFact } from "../memory/profile-store.js";
import { executeStep } from "./step-executor.js";
import type { StepEvent } from "./step-executor.js";
import { LoopDetector, formatRepeatNotice } from "./loop-detector.js";
import type { AgentMetrics } from "../telemetry/agent-metrics.js";
import type { StructuredLogger } from "../telemetry/structured-logger.js";

export interface AgentLoopDependencies {
  registry: ToolRegistry;
  slotManager: SlotManager;
  grammar: string;
  llmComplete: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => Promise<CompletionResult>;
  /**
   * Optional streaming sibling of `llmComplete`. When wired, live
   * `reasoning_delta` and `assistant_delta` step events flow to
   * `onEvent` while the model is still generating.
   */
  llmCompleteStream?: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => AsyncGenerator<StreamChunk, CompletionResult, void>;
  /** Stable tool catalog used in the prompt prefix. Pass the same array on every step. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Stable capabilities summary, computed once at session start. */
  capabilities: CapabilitiesSummary;
  /** Model-specific reasoning behaviour derived from llama-server /props. */
  profile?: ModelProfile;
  /** Skill catalog (name + description only), rebuilt on install/uninstall. */
  skillCatalog: readonly SkillCatalogEntry[];
  /**
   * Invoked once per step to produce the current user-profile snapshot.
   * The resulting array is rendered into the `### profile` section of
   * the prompt tail. `undefined` suppresses the section entirely — wire
   * this only when the memory fabric is enabled.
   */
  profileFactsProvider?: () => readonly ProfileFact[];
  onEvent?: (event: AgentLoopEvent) => void;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
}

export interface RunTurnOptions {
  maxSteps: number;
  signal: AbortSignal;
  /** Optional new user message to append before stepping. */
  userMessage?: string;
}

/** Why a `runTurn` invocation returned. */
export type AgentLoopReason =
  | "reply"
  | "finish"
  | "max_steps"
  | "cancelled"
  | "failed";

export type AgentLoopEvent =
  | { type: "user_message"; text: string }
  | { type: "turn_started"; turnIndex: number }
  | {
      type: "turn_finished";
      turnIndex: number;
      reason: AgentLoopReason;
      stepCount: number;
      durationMs: number;
    }
  | { type: "step_started"; stepIndex: number }
  | {
      type: "step_finished";
      stepIndex: number;
      summary: string;
      durationMs: number;
    }
  | { type: "llm_event"; event: StepEvent }
  | {
      /**
       * Fired once per detected no-progress run. Carries the tool name and
       * the length of the identical-step streak. The runtime will inject a
       * one-shot notice into the next prompt; UIs can use this event to
       * flag the turn visually.
       */
      type: "loop_detected";
      tool: string;
      count: number;
      stepIndex: number;
    }
  | {
      type: "loop_completed";
      reason: AgentLoopReason;
    }
  /**
   * Terminal failure for the turn. `category` follows the canonical
   * LLM-failure taxonomy (see `src/llm/reliability/`); downstream
   * consumers never need to classify the error themselves.
   */
  | { type: "loop_failed"; error: Error; category: LlmFailureCategory };

export interface RunTurnResult {
  session: SessionState;
  reason: AgentLoopReason;
  stepCount: number;
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDependencies) {}

  /**
   * Drive one macro-turn:
   *   user message → 0..N tool steps → `reply` (or `finish` / max_steps).
   *
   * The loop:
   *  - Appends the user message (when supplied) to the transcript.
   *  - Executes steps until a terminal tool is emitted or the budget runs out.
   *  - On `reply`: returns with `reason: "reply"`, session stays open.
   *  - On `finish`: returns with `reason: "finish"`, session marked completed.
   *  - On `max_steps`: synthesises a fallback assistant reply so the user
   *    is never left without a turn closing.
   */
  async runTurn(
    session: SessionState,
    options: RunTurnOptions,
  ): Promise<RunTurnResult> {
    let state = session;

    if (options.userMessage !== undefined) {
      const text = options.userMessage;
      state = recordTurn(state, userTurn(text));
      this.deps.onEvent?.({ type: "user_message", text });
    }

    const turnIndex = state.turnCount;
    this.deps.onEvent?.({ type: "turn_started", turnIndex });
    const turnStartedAt = Date.now();

    let reason: AgentLoopReason = "max_steps";
    let stepsTaken = 0;
    let runError: Error | null = null;
    const loopDetector = new LoopDetector();
    // One-shot notice injected into the NEXT step's prompt only. Cleared
    // as soon as it is consumed so the stable tail does not carry stale
    // nudges across steps.
    let pendingNotice: string | undefined;

    state = { ...state, status: "running" };

    for (let i = 0; i < options.maxSteps; i += 1) {
      if (options.signal.aborted) {
        reason = "cancelled";
        break;
      }
      this.deps.onEvent?.({ type: "step_started", stepIndex: i });
      const started = Date.now();
      const noticeForThisStep = pendingNotice;
      pendingNotice = undefined;
      try {
        const profileFacts = this.deps.profileFactsProvider?.();
        const outcome = await executeStep(
          {
            session: state,
            toolDescriptors: this.deps.toolDescriptors,
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            stepIndex: i,
            signal: options.signal,
            ...(noticeForThisStep !== undefined
              ? { transientNotice: noticeForThisStep }
              : {}),
            ...(profileFacts !== undefined ? { profileFacts } : {}),
          },
          {
            registry: this.deps.registry,
            slotManager: this.deps.slotManager,
            grammar: this.deps.grammar,
            profile: this.deps.profile ?? PLAIN_INSTRUCT_PROFILE,
            llmComplete: this.deps.llmComplete,
            ...(this.deps.llmCompleteStream
              ? { llmCompleteStream: this.deps.llmCompleteStream }
              : {}),
            onEvent: (event) =>
              this.deps.onEvent?.({ type: "llm_event", event }),
            ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
            ...(this.deps.logger ? { logger: this.deps.logger } : {}),
          },
        );
        const durationMs = Date.now() - started;
        state = outcome.nextSession;
        stepsTaken += 1;
        const tokensUsed =
          (outcome.completion.timing?.promptTokens ?? outcome.prompt.tokens.total) +
          (outcome.completion.timing?.predictedTokens ?? 0);
        this.deps.metrics?.recordStep({
          sessionId: state.id,
          stepIndex: i,
          tokensUsed,
          durationMs,
          outcome: outcome.toolResult.status,
        });
        this.deps.onEvent?.({
          type: "step_finished",
          stepIndex: i,
          summary: outcome.toolResult.summary,
          durationMs,
        });
        if (outcome.terminal === "session") {
          reason = "finish";
          state = { ...state, status: "completed" };
          break;
        }
        if (outcome.terminal === "turn") {
          reason = "reply";
          break;
        }
        // Feed the detector AFTER terminal checks so `reply`/`finish` never
        // trigger a hint (those steps legitimately look identical to the
        // previous tool output).
        const verdict = loopDetector.observe({
          tool: outcome.toolCall.tool,
          args: outcome.toolCall.args,
          resultSummary: outcome.toolResult.summary,
          worldDigest: state.worldSnapshot?.digest ?? null,
        });
        if (verdict.kind === "repeat") {
          pendingNotice = formatRepeatNotice(verdict);
          this.deps.logger?.warn("no-progress loop detected", {
            sessionId: state.id,
            stepIndex: i,
            tool: verdict.tool,
            count: verdict.count,
          });
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: verdict.tool,
            count: verdict.count,
            stepIndex: i,
          });
        }
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        const category = classifyFailure(err);
        this.deps.logger?.error("agent loop failed", {
          sessionId: state.id,
          stepIndex: i,
          error: runError.message,
          category,
        });
        this.deps.onEvent?.({
          type: "loop_failed",
          error: runError,
          category,
        });
        this.deps.metrics?.recordLlmFailure({
          sessionId: state.id,
          category,
        });
        // `cancelled` is user-initiated and should close the turn
        // cleanly without marking the session as failed. Everything
        // else keeps the existing failed-terminal contract.
        const cancelled =
          err instanceof CancelledError ||
          (err instanceof LlmFailure && err.category === "cancelled") ||
          category === "cancelled";
        if (cancelled) {
          state = { ...state, status: "cancelled" };
          this.deps.onEvent?.({ type: "loop_completed", reason: "cancelled" });
          state = incrementTurnCount(state);
          const durationMs = Date.now() - turnStartedAt;
          this.deps.onEvent?.({
            type: "turn_finished",
            turnIndex,
            reason: "cancelled",
            stepCount: stepsTaken,
            durationMs,
          });
          return { session: state, reason: "cancelled", stepCount: stepsTaken };
        }
        state = { ...state, status: "failed", lastError: runError.message };
        const durationMs = Date.now() - turnStartedAt;
        this.deps.onEvent?.({
          type: "turn_finished",
          turnIndex,
          reason: "failed",
          stepCount: stepsTaken,
          durationMs,
        });
        throw runError;
      }
    }

    if (reason === "cancelled") {
      state = { ...state, status: "cancelled" };
      this.deps.onEvent?.({ type: "loop_completed", reason });
    } else if (reason === "max_steps") {
      const synthetic = "(stopped: max_steps reached without a reply)";
      state = recordTurn(state, assistantReplyTurn(synthetic));
      this.deps.onEvent?.({ type: "llm_event", event: { type: "assistant_reply", text: synthetic } });
      this.deps.onEvent?.({ type: "loop_completed", reason });
      if (state.status !== "completed") {
        // `stalled` (not `pending`) signals to operators that the turn
        // hit the step budget without a natural close. `lastError`
        // carries the machine-readable reason plus the observed step
        // count so post-mortem tooling does not need to replay events.
        state = {
          ...state,
          status: "stalled",
          lastError: `max_steps_reached: ${stepsTaken} steps without reply`,
        };
      }
    } else if (reason === "reply") {
      state = { ...state, status: "pending" };
      this.deps.onEvent?.({ type: "loop_completed", reason });
    } else if (reason === "finish") {
      this.deps.logger?.info("agent loop finished via finish tool", {
        sessionId: state.id,
      });
      this.deps.onEvent?.({ type: "loop_completed", reason });
    }

    state = incrementTurnCount(state);
    const durationMs = Date.now() - turnStartedAt;
    this.deps.onEvent?.({
      type: "turn_finished",
      turnIndex,
      reason,
      stepCount: stepsTaken,
      durationMs,
    });

    return { session: state, reason, stepCount: stepsTaken };
  }
}
