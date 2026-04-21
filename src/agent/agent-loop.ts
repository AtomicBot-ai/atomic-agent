import type { CompletionResult } from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
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
import { executeStep } from "./step-executor.js";
import type { StepEvent } from "./step-executor.js";
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
  /** Stable tool catalog used in the prompt prefix. Pass the same array on every step. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Stable capabilities summary, computed once at session start. */
  capabilities: CapabilitiesSummary;
  /** Skill catalog (name + description only), rebuilt on install/uninstall. */
  skillCatalog: readonly SkillCatalogEntry[];
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
      type: "loop_completed";
      reason: AgentLoopReason;
    }
  | { type: "loop_failed"; error: Error };

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

    state = { ...state, status: "running" };

    for (let i = 0; i < options.maxSteps; i += 1) {
      if (options.signal.aborted) {
        reason = "cancelled";
        break;
      }
      this.deps.onEvent?.({ type: "step_started", stepIndex: i });
      const started = Date.now();
      try {
        const outcome = await executeStep(
          {
            session: state,
            toolDescriptors: this.deps.toolDescriptors,
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            stepIndex: i,
            signal: options.signal,
          },
          {
            registry: this.deps.registry,
            slotManager: this.deps.slotManager,
            grammar: this.deps.grammar,
            llmComplete: this.deps.llmComplete,
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
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        this.deps.logger?.error("agent loop failed", {
          sessionId: state.id,
          stepIndex: i,
          error: runError.message,
        });
        this.deps.onEvent?.({ type: "loop_failed", error: runError });
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
        state = { ...state, status: "pending" };
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
