import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import type { ToolCallTransport } from "../llm/provider/completion-types.js";
import type { ToolCallAdapter } from "../llm/provider/adapters/tool-call-adapter.js";
import {
  PLAIN_INSTRUCT_PROFILE,
  type ModelProfile,
} from "../llm/model-profile.js";
import type { ModelProfileManager } from "../llm/model-profile-manager.js";
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
import type {
  MemoryEntry,
  MemoryIndexEntry,
} from "../memory/memory-store.js";
import type { LessonIndexEntry } from "../memory/lessons/lesson-store.js";
import type { ProcedureIndexEntry } from "../memory/procedures/procedure-store.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { ReflectionRunner } from "../memory/reflection/index.js";
import { executeStep } from "./step-executor.js";
import type { LlmStreamParams, StepEvent } from "./step-executor.js";
import {
  ToolLoopTracker,
  formatRepeatNotice,
  formatWanderingRedirect,
  formatForcedLoopReply,
} from "./loop-detector.js";
import type { BatchLoopSignal } from "./batch-executor.js";
import { composeSteerNotice } from "./steer-notice.js";
import { getConfig } from "../config/index.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

export interface AgentLoopDependencies {
  registry: ToolRegistry;
  /**
   * Plan mode, read per call. A getter rather than a boolean so a mode
   * the operator flips mid-session is observed by the next tool call
   * rather than by the next process — the same reasoning the approval
   * gate uses for `approvalRequired`.
   */
  isPlanMode?: () => boolean;
  slotManager: SlotManager;
  grammar: string;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  /**
   * Optional streaming sibling of `llmComplete`. When wired, live
   * `reasoning_delta` and `assistant_delta` step events flow to
   * `onEvent` while the model is still generating.
   */
  llmCompleteStream?: (
    params: LlmStreamParams,
  ) => AsyncGenerator<StreamChunk, CompletionResult, void>;
  /** Stable tool catalog used in the prompt prefix. Pass the same array on every step. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Stable capabilities summary, computed once at session start. */
  capabilities: CapabilitiesSummary;
  /** Model-specific reasoning behaviour derived from llama-server /props. */
  profile?: ModelProfile;
  /**
   * Context window resolved from the model catalogue, for providers with
   * no `/props` probe. Read per step so a mid-session model swap is
   * reflected without restarting the loop.
   */
  contextWindow?: () => number | null;
  /** Defaults to `grammar` when omitted (test / legacy wiring). */
  toolTransport?: ToolCallTransport;
  toolCallAdapter?: ToolCallAdapter | null;
  supportsSlotAffinity?: boolean;
  /**
   * Whether the active native-tools provider can emit parallel tool
   * calls. Defaults to `true` when omitted (legacy / grammar-only
   * wiring). Combined with `agent.maxParallelToolCalls` to decide the
   * `parallel_tool_calls` wire flag (issue #104).
   */
  supportsParallelTools?: boolean;
  /**
   * Optional hot-swap supervisor. When provided, the loop re-probes
   * `/props` at the start of every turn and inspects the `modelId` of
   * each completion; if the operator swaps the model behind
   * `llama-server`, the profile and grammar are refreshed before the
   * next step so the prompt no longer drifts out of template. When
   * absent, the static `profile`/`grammar` deps above are used verbatim
   * for the lifetime of the loop (test-mode wiring).
   */
  profileManager?: ModelProfileManager;
  /** Skill catalog (name + description only), rebuilt on install/uninstall. */
  skillCatalog: readonly SkillCatalogEntry[];
  /**
   * Invoked once per step to produce the current user-profile snapshot.
   * The resulting array is rendered into the `### profile` section of
   * the prompt tail. `undefined` suppresses the section entirely — wire
   * this only when the memory fabric is enabled.
   */
  profileFactsProvider?: () => readonly ProfileFact[];
  /**
   * Optional pre-step memory hook. Invoked before the first step and
   * refreshed after non-terminal tool results to populate the ephemeral
   * `recalledNotes` / `memoryIndex` fields on the session state. Those
   * are rendered into the `### recalled` and `### memory-index`
   * sections of every step's prompt without touching the stable prefix.
   *
   * The provider is expected to:
   *  - Run BM25 recall for the top-K notes against `userMessage` plus
   *    recent tool-result summaries when present.
   *  - List the compact memory index (most recent pointers).
   *  - Deduplicate: entries returned in `recalled` must not reappear in
   *    `index`, and vice versa — the renderer does no dedup itself.
   *
   * Errors and timeouts are the provider's responsibility; the loop
   * never awaits longer than a few hundred ms in practice and will
   * silently skip injection if the provider throws.
   */
  memoryContextProvider?: MemoryContextProvider;
  /**
   * Optional end-of-turn memory reflection. When present, the loop
   * fires `reflect({ sessionId, userMessage, assistantReply })` in
   * the background once the reply is ready — never awaited, never
   * allowed to throw. Race protection between fires on the same
   * session is enforced INSIDE `ReflectionRunner.runOne` (the new
   * reflect call aborts the previous controller for the same
   * sessionId before starting), so the agent loop does NOT call
   * `abortPending` per turn — see commit message / [PR ref] for the
   * abort-race fix. Shutdown still calls `abortPending()` with no
   * sessionId to drain everything in flight.
   * The loop knows nothing about prompts, grammars, or slot IDs; all of
   * that lives in `src/memory/reflection/`.
   */
  reflectionRunner?: ReflectionRunner;
  /**
   * v2.5 (Phase B — config v18). Sliding-window
   * reflection segmentation. When present and `enabled`, the loop
   * fires `reflectionRunner.reflect(...)` only every
   * `triggerEveryTurns` turns (or unconditionally on `reason: "finish"`
   * — the final-flush invariant). Each fire packs the last
   * `windowTurns` user/assistant pairs into `ReflectionInput.transcript`
   * so the model can extract durable signal across topic-cohesive
   * episodes instead of per-pair micro-reflections.
   *
   * When absent or `enabled === false`, the loop falls back to the
   * legacy per-reply trigger and the single-pair prompt (byte-stable
   * with pre-config-v18 callers).
   */
  reflectionSegmentation?: ReflectionSegmentationConfig;
  /**
   * Memory-v2 phase 6 — lesson lifecycle hook.
   *
   * Invoked exactly once at the end of every `runTurn` with the
   * union of lesson ids that were surfaced into `### lessons`
   * across the turn (`state.recalledLessons` may be refreshed
   * per-step) and the terminal reason. Cross-phase invariants:
   *
   *  - **Once per turn, deduplicated.** Even if the same lesson
   *    surfaced on multiple steps, the bump fires exactly once.
   *  - **No bump for cancelled / max_steps.** Those are neither
   *    success nor failure signals; phase 7a may revisit
   *    `max_steps` as a soft negative once vote curation lands.
   *  - **Fire-safe.** The hook is invoked synchronously after
   *    `turn_finished` is emitted; errors are swallowed by the
   *    caller so a sqlite hiccup never derails the return path.
   *
   * Pinned by `agent-loop-lesson-lifecycle.test.ts`.
   */
  lessonLifecycle?: LessonLifecycleHook;
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * Out-of-band channel for user messages that arrive while this turn is
   * already running (`SteeringInbox`). Drained at the top of every step
   * and folded into that step's `### notice`; see §"Mid-turn steering"
   * in AGENTS.md. Absent in tests and in surfaces that do not offer
   * steering, in which case the loop behaves exactly as before.
   */
  steeringInbox?: SteeringChannel;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
}

/**
 * v2.5 (Phase B — config v18). Runtime knobs for
 * sliding-window reflection segmentation. `triggerEveryTurns` is the
 * cadence (every Nth turn fires; the rest are deferred), `windowTurns`
 * is the size of the user/assistant pair window packed into the
 * reflection prompt. Both must be `>= 1`.
 */
export interface ReflectionSegmentationConfig {
  enabled: boolean;
  triggerEveryTurns: number;
  windowTurns: number;
}

export interface MemoryContextProviderInput {
  sessionId: string;
  userMessage: string | null;
  toolResultSummaries?: readonly string[];
  signal: AbortSignal;
  /**
   * v2.5 (Phase A — config v18). Trailing
   * user/assistant exchanges projected from `SessionState.turns`,
   * supplied by the agent loop. Decorators (e.g. the heuristic-gated
   * query rewriter under `src/memory/retrieve/`) read this field to
   * resolve referential follow-ups against the recent context.
   *
   * The default provider ignores this field — older callers stay
   * byte-stable. The list does NOT include the just-arrived user
   * message — that is in `userMessage` instead.
   */
  recentTurns?: readonly { role: "user" | "assistant"; text: string }[];
}

export interface MemoryContext {
  recalled: readonly MemoryEntry[];
  index: readonly MemoryIndexEntry[];
  /**
   * Memory-v2 phase 5. Top-K pointer rows from `LessonStore` for the
   * current turn. Optional so phase 1A/B/2/3/4 providers stay
   * source-compatible — missing field is treated as "no lessons".
   */
  lessons?: readonly LessonIndexEntry[];
  /**
   * Memory-v2 phase 7b. Top-K pointer rows from `ProcedureStore`
   * for the current turn. Optional so older providers stay
   * source-compatible. Rendered as `### procedures` between
   * `### lessons` and `### memory-index` in the variable tail.
   */
  procedures?: readonly ProcedureIndexEntry[];
}

export interface MemoryContextProvider {
  buildMemoryContext(
    input: MemoryContextProviderInput,
  ): Promise<MemoryContext> | MemoryContext;
}

/**
 * Memory-v2 phase 6. Outcome signal for `LessonLifecycleHook`.
 * `reply` and `finish` are positive; `failed` is negative;
 * `cancelled` / `max_steps` are filtered out by the caller before
 * invoking the hook (so implementations only see informative
 * outcomes).
 */
export type LessonLifecycleOutcome = "success" | "failure";

export interface LessonLifecycleHook {
  /**
   * Bump `success_count` / `failure_count` for each surfaced lesson
   * id, once per turn. Implementations must be idempotent — the
   * loop deduplicates ids before invoking the hook, but a
   * paranoid implementation is welcome to dedupe again.
   */
  recordTurnOutcome(args: {
    sessionId: string;
    surfacedLessonIds: readonly number[];
    outcome: LessonLifecycleOutcome;
  }): void;
}

/**
 * The turn's side of the steering inbox. Declared structurally (like
 * {@link MemoryContextProvider}) so `src/agent/` does not import from
 * `src/runtime/`, which imports it.
 *
 * The loop owns the window in which steering is accepted: `open` when
 * the turn starts, `drain` at every step boundary, `closeAndDrain`
 * exactly once on the way out. `closeAndDrain` is what makes "the turn
 * can still pick messages up" and "the last drain has happened" the
 * same fact — see the comment on `SteeringInbox.accepting`.
 */
export interface SteeringChannel {
  open(sessionId: string): void;
  drain(sessionId: string): readonly string[];
  closeAndDrain(sessionId: string): readonly string[];
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
  /**
   * A message the user sent mid-turn was folded into the prompt for
   * step `stepIndex`. Distinct from `user_message`, which marks the
   * message that *started* the turn — UIs render this one inline in the
   * running turn rather than as the opening of a new one.
   */
  | { type: "steer_applied"; text: string; stepIndex: number }
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
      /** Graduated severity from the `ToolLoopTracker`. */
      level?: "warn" | "critical" | "breaker";
      /** Which sub-detector fired. */
      detector?: "generic_repeat" | "no_progress" | "wandering";
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
  | { type: "loop_failed"; error: Error; category: LlmFailureCategory }
  /**
   * The provider fallback chain changed the active provider for this
   * turn. `direction: "away"` = the primary was unreachable and we
   * switched to a fallback; `direction: "back"` = a throttled probe found
   * the primary healthy again and we returned to it. Emitted at most once
   * per state transition (never on sticky turns). See AGENTS.md
   * §"Provider fallback chain".
   */
  | {
      type: "provider_switched";
      direction: "away" | "back";
      from: string;
      to: string;
      reason: string;
    };

export interface RunTurnResult {
  session: SessionState;
  reason: AgentLoopReason;
  stepCount: number;
  /**
   * Steering messages that were pushed but never reached a step — the
   * turn ended (or was cancelled) before the loop could drain them.
   * Callers MUST re-route these, normally onto their own message queue,
   * otherwise a message the user watched being accepted vanishes. Empty
   * on every ordinary turn.
   */
  undelivered?: readonly string[];
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
   *
   * The wrapper owns the mid-turn steering window: it is open for
   * exactly the lifetime of this call, and it closes in the same
   * indivisible step as the loop's final drain (see `flushSteering`).
   * A `steer()` that lands after that is refused, not stranded.
   */
  async runTurn(
    session: SessionState,
    options: RunTurnOptions,
  ): Promise<RunTurnResult> {
    this.deps.steeringInbox?.open(session.id);
    try {
      return await this.runTurnInner(session, options);
    } finally {
      // Every ordinary exit already closed the window through
      // `flushSteering` — a `return` expression is evaluated before
      // this block runs, so `undelivered` is unaffected and this call
      // is a no-op. What it catches is the throw path (a programming
      // bug escaping the classified-error handling above): without it
      // the session would stay open forever and every later `steer()`
      // would be accepted into an inbox nobody drains.
      const stranded = this.deps.steeringInbox?.closeAndDrain(session.id) ?? [];
      if (stranded.length > 0) {
        this.deps.logger?.warn("mid-turn steering stranded by a failed turn", {
          sessionId: session.id,
          count: stranded.length,
        });
      }
    }
  }

  private async runTurnInner(
    session: SessionState,
    options: RunTurnOptions,
  ): Promise<RunTurnResult> {
    let state = session;

    // NOTE: previously called `reflectionRunner.abortPending({ sessionId })`
    // here on every turn to "free the reflection slot quickly". That
    // was over-aggressive: reflection fires only every Nth turn under
    // segmentation, but the abort fired on every turn — so reflection
    // from turn K was reliably cancelled at the start of turn K+1
    // (within ~5ms of being fired, before the LLM call could even
    // respond). Net effect: in 75-turn LoCoMo runs, 0 reflection
    // writes landed. Confirmed via debug instrumentation in
    // `reflection-runner.ts` — see commit message / [PR ref] for the
    // 6-prompt e2e probe that pinned the race.
    //
    // The race-prevention contract is already enforced INSIDE
    // `ReflectionRunner.runOne`: when a NEW reflect() is about to
    // start for the same session, it aborts the previous controller
    // first (see `previous?.abort()` in `runOne`). Reflection writes
    // are additive, so a late-landing write from turn K landing
    // during turn K+2 is harmless — the next prompt-build sees the
    // strictly larger memory set.
    //
    // Shutdown path still calls `abortPending()` with no sessionId
    // to drain every in-flight reflection before the runtime tears
    // down SQLite handles.

    if (options.userMessage !== undefined) {
      const text = options.userMessage;
      state = recordTurn(state, userTurn(text));
      this.deps.onEvent?.({ type: "user_message", text });
    }

    const turnIndex = state.turnCount;
    this.deps.onEvent?.({ type: "turn_started", turnIndex });
    const turnStartedAt = Date.now();

    state = await refreshMemoryContext(this.deps, state, options);

    // Proactively sync with the live `llama-server` before the first
    // step. Catches the case where the operator swapped the model
    // between turns — without this, step 0 would still build the prompt
    // with the previous model's template.
    if (this.deps.profileManager) {
      await this.deps.profileManager.refresh();
    }

    let reason: AgentLoopReason = "max_steps";
    let stepsTaken = 0;
    let runError: Error | null = null;
    // Per-turn no-progress loop tracker (OpenClaw-style). Threaded into
    // `executeStep` so the synchronous batch gate can veto looping calls
    // before they are dispatched; the agent loop consumes the resulting
    // `loopSignals` after each step to inject notices and trigger the
    // graceful breaker termination.
    const agentCfg = getConfig().agent;
    const loopTracker = new ToolLoopTracker({
      warningThreshold: agentCfg.loopWarningThreshold,
      criticalThreshold: agentCfg.loopCriticalThreshold,
      breakerVetoStreak: agentCfg.loopBreakerVetoStreak,
      historySize: agentCfg.loopHistorySize,
      wanderingThreshold: agentCfg.loopWanderingThreshold,
      wanderingEscalation: agentCfg.loopWanderingEscalation,
    });
    // Memory-v2 phase 6 — accumulate the union of lesson ids surfaced
    // across every step of this turn. `refreshMemoryContext` may
    // recompute `state.recalledLessons` per step; we record each new
    // id as it lands so the lifecycle hook fires once-per-turn-per-id
    // even when the same lesson keeps re-surfacing.
    const surfacedLessonIds = new Set<number>();
    const recordSurfacedLessons = (s: SessionState): void => {
      for (const l of s.recalledLessons ?? []) {
        surfacedLessonIds.add(l.id);
      }
    };
    recordSurfacedLessons(state);
    // Memory-v2 phase 7b — same accumulator, but for procedure ids.
    // Surfaces into the vote-runner allowlist so the LLM can only
    // vote on procedures it actually saw in `### procedures`.
    const surfacedProcedureIds = new Set<number>();
    const recordSurfacedProcedures = (s: SessionState): void => {
      for (const p of s.recalledProcedures ?? []) {
        surfacedProcedureIds.add(p.id);
      }
    };
    recordSurfacedProcedures(state);
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
      // Reactive refresh between steps: if the previous completion
      // observed a foreign `modelId`, rebuild profile + grammar so the
      // next prompt matches what `llama-server` is actually serving.
      if (this.deps.profileManager) {
        await this.deps.profileManager.refreshIfStale();
      }
      this.deps.onEvent?.({ type: "step_started", stepIndex: i });
      const started = Date.now();
      // Mid-turn steering: anything the user sent since the previous
      // step boundary joins this step's prompt. It is recorded as a
      // real `user` turn (the transcript must reflect what was said,
      // and `packConversation` always keeps the last user turn visible)
      // AND repeated in `### notice`, which is the tail-most block the
      // model reads before `### respond`. `composeSteerNotice` appends
      // to whatever the loop detector already left in `pendingNotice`
      // rather than overwriting it — both nudges matter.
      const steered = this.deps.steeringInbox?.drain(state.id) ?? [];
      for (const text of steered) {
        state = recordTurn(state, userTurn(text));
        this.deps.onEvent?.({ type: "steer_applied", text, stepIndex: i });
      }
      if (steered.length > 0) {
        pendingNotice = composeSteerNotice(pendingNotice, steered);
        this.deps.logger?.info("mid-turn steering applied", {
          sessionId: state.id,
          stepIndex: i,
          count: steered.length,
        });
      }
      const noticeForThisStep = pendingNotice;
      pendingNotice = undefined;
      const finalizationStep = i === options.maxSteps - 1;
      const finalizationNotice =
        "This is the final allowed step. Do not call any non-terminal tool; " +
        "summarize the completed work with reply, or end the session with finish.";
      try {
        const profileFacts = this.deps.profileFactsProvider?.();
        const activeProfile =
          this.deps.profileManager?.getProfile() ??
          this.deps.profile ??
          PLAIN_INSTRUCT_PROFILE;
        const activeGrammar =
          this.deps.profileManager?.getGrammar() ?? this.deps.grammar;
        const outcome = await executeStep(
          {
            session: state,
            toolDescriptors: finalizationStep
              ? this.deps.toolDescriptors.filter(
                  ({ name }) => name === "reply" || name === "finish",
                )
              : this.deps.toolDescriptors,
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            stepIndex: i,
            signal: options.signal,
            ...(finalizationStep || noticeForThisStep !== undefined
              ? {
                  transientNotice: [
                    noticeForThisStep,
                    ...(finalizationStep ? [finalizationNotice] : []),
                  ]
                    .filter((notice): notice is string => notice !== undefined)
                    .join("\n\n"),
                }
              : {}),
            ...(finalizationStep ? { terminalOnly: true } : {}),
            ...(profileFacts !== undefined ? { profileFacts } : {}),
            ...(options.userMessage !== undefined
              ? { userMessage: options.userMessage }
              : {}),
          },
          {
            registry: this.deps.registry,
            ...(this.deps.isPlanMode
              ? { isPlanMode: this.deps.isPlanMode }
              : {}),
            slotManager: this.deps.slotManager,
            grammar: activeGrammar,
            profile: activeProfile,
            ...(this.deps.contextWindow
              ? { contextWindow: this.deps.contextWindow() }
              : {}),
            toolTransport: this.deps.toolTransport ?? "grammar",
            toolCallAdapter: this.deps.toolCallAdapter ?? null,
            supportsSlotAffinity: this.deps.supportsSlotAffinity ?? true,
            supportsParallelTools: this.deps.supportsParallelTools ?? true,
            llmComplete: this.deps.llmComplete,
            ...(this.deps.llmCompleteStream
              ? { llmCompleteStream: this.deps.llmCompleteStream }
              : {}),
            ...(this.deps.profileManager
              ? {
                  onCompletion: (completion: CompletionResult) =>
                    this.deps.profileManager?.observeCompletionModelId(
                      completion.modelId,
                    ),
                }
              : {}),
            onEvent: (event) =>
              this.deps.onEvent?.({ type: "llm_event", event }),
            ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
            ...(this.deps.logger ? { logger: this.deps.logger } : {}),
            tracker: loopTracker,
          },
        );
        const durationMs = Date.now() - started;
        state = outcome.nextSession;
        stepsTaken += 1;
        const tokensUsed =
          (outcome.completion.timing?.promptTokens ?? outcome.prompt.tokens.total) +
          (outcome.completion.timing?.predictedTokens ?? 0);
        // Step-level outcome rolls up batched results: any failed call
        // marks the step as `error` so metrics catch partial failures.
        const stepStatus: "ok" | "error" = outcome.toolResults.some(
          (r) => r.status === "error",
        )
          ? "error"
          : "ok";
        // Feed summary mirrors the legacy single-call shape for solo
        // steps; for a batch we render `N tools: t1, t2, …` so the TUI
        // and trace consumer see at a glance that this was a batch.
        const summary =
          outcome.toolResults.length === 1
            ? outcome.toolResults[0]!.summary
            : `${outcome.toolResults.length} tools: ${outcome.toolResults
                .map((r) => `${r.tool}[${r.status}]`)
                .join(", ")}`;
        this.deps.metrics?.recordStep({
          sessionId: state.id,
          stepIndex: i,
          tokensUsed,
          durationMs,
          outcome: stepStatus,
        });
        this.deps.onEvent?.({
          type: "step_finished",
          stepIndex: i,
          summary,
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
        // A trimmed-batch step (auto-split: approval-gated solo) seeds
        // the next step's `pendingNotice` so the model sees which calls
        // were dropped and can retry them as length-1 arrays. The
        // loop-signal path below may overwrite this with a repeat
        // notice — that is intentional: a loop hint outranks a trim
        // hint since the loop indicates the model failed to make
        // progress over multiple steps. A wave-split step (issue #111)
        // seeds its notice the same way — nothing was dropped, but the
        // model should know its oversized read array ran in bounded
        // waves.
        if (outcome.trimmedBatchNotice !== undefined) {
          pendingNotice = outcome.trimmedBatchNotice;
        } else if (outcome.waveSplitNotice !== undefined) {
          pendingNotice = outcome.waveSplitNotice;
        }

        // The synchronous batch gate (inside `executeStep`) already
        // produced graduated loop signals for this step. Terminal verbs
        // are never gated, so `reply`/`finish` steps carry no signals.
        // Additionally feed a composite-batch observation for multi-call
        // steps so two identical batches in a row (whose individual calls
        // each have unique args and therefore never trip the per-call
        // gate) are still flagged — a permuted batch is not (the hash is
        // order-sensitive). Composite hits are advisory only (notice),
        // never a veto: the calls already executed.
        const loopSignals: BatchLoopSignal[] = [...outcome.loopSignals];
        if (outcome.toolCalls.length > 1) {
          const composite = loopTracker.observeBatchComposite(
            outcome.toolCalls.map((call) => ({
              tool: call.tool,
              args: call.args,
            })),
            outcome.toolResults,
          );
          if (composite.level !== "ok") {
            loopSignals.push({
              kind: "warn",
              tool: composite.tool,
              count: composite.count,
              detector: composite.detector,
              warningKey: composite.warningKey,
            });
          }
        }

        // Breaker: the model ignored repeated vetoes of the same call.
        // Force a graceful synthetic reply (NOT a `loop_failed` — the
        // turn ends with a best-effort answer, the session stays usable).
        const breaker = loopSignals.find((s) => s.kind === "breaker");
        if (breaker) {
          const replyText = formatForcedLoopReply(breaker.tool, breaker.count);
          state = recordTurn(state, assistantReplyTurn(replyText));
          this.deps.onEvent?.({
            type: "llm_event",
            event: { type: "assistant_reply", text: replyText },
          });
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: breaker.tool,
            count: breaker.count,
            stepIndex: i,
            level: "breaker",
            detector: breaker.detector,
          });
          this.deps.logger?.warn(
            "no-progress loop breaker tripped; forcing graceful reply",
            {
              sessionId: state.id,
              stepIndex: i,
              tool: breaker.tool,
              count: breaker.count,
            },
          );
          reason = "reply";
          break;
        }

        // Critical vetoes: the synthetic veto result already carries the
        // instruction in the transcript. Surface the event so UIs/traces
        // flag it; no extra notice needed.
        for (const sig of loopSignals) {
          if (sig.kind !== "critical") continue;
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: sig.tool,
            count: sig.count,
            stepIndex: i,
            level: "critical",
            detector: sig.detector,
          });
          this.deps.logger?.warn("no-progress loop: call vetoed", {
            sessionId: state.id,
            stepIndex: i,
            tool: sig.tool,
            count: sig.count,
          });
        }

        // Warn repeats: inject a one-shot `### notice` for the next step,
        // de-duplicated per `warningKey` so the same nudge is not
        // re-injected on every subsequent identical step.
        for (const sig of loopSignals) {
          if (sig.kind !== "warn") continue;
          if (!loopTracker.shouldEmitWarning(sig.warningKey, sig.count)) {
            continue;
          }
          pendingNotice =
            sig.detector === "wandering"
              ? formatWanderingRedirect(sig.tool, sig.count)
              : formatRepeatNotice(sig);
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: sig.tool,
            count: sig.count,
            stepIndex: i,
            level: "warn",
            detector: sig.detector,
          });
          this.deps.logger?.warn("no-progress loop detected", {
            sessionId: state.id,
            stepIndex: i,
            tool: sig.tool,
            count: sig.count,
          });
        }
        state = await refreshMemoryContext(this.deps, state, options);
        recordSurfacedLessons(state);
        recordSurfacedProcedures(state);
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        const category = classifyFailure(err);
        // `cancelled` is user-initiated and should close the turn
        // cleanly without marking the session as failed. Classified
        // BEFORE the finalization guard below: a user abort during the
        // reserved final step must keep its `cancelled` outcome
        // (issue #107 — cancellation semantics remain unchanged), not
        // be relabelled `max_steps`.
        const cancelled =
          err instanceof CancelledError ||
          (err instanceof LlmFailure && err.category === "cancelled") ||
          category === "cancelled";
        if (finalizationStep && !cancelled) {
          // A failed finalization must not execute more work or turn a
          // bounded run into an unbounded retry. Preserve the established
          // explicit max-steps/stalled outcome instead.
          this.deps.logger?.warn(
            "finalization step failed; preserving max-steps outcome",
            {
              sessionId: state.id,
              stepIndex: i,
              error: runError.message,
              category,
            },
          );
          stepsTaken += 1;
          reason = "max_steps";
          break;
        }
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
          return {
            session: state,
            reason: "cancelled",
            stepCount: stepsTaken,
            undelivered: this.flushSteering(state.id),
          };
        }
        // Symmetric with the cancelled path above: set terminal state,
        // emit `loop_completed` + `turn_finished`, increment turnCount,
        // and RETURN — never throw. Callers (CLI / TUI / task-runner /
        // OpenAI HTTP / Telegram) all already key off
        // `result.session.status === "failed"` or `result.reason ===
        // "failed"`; the throw was an unintended asymmetry that
        // pre-dated the `failed` branch in `task-runner.ts:288-294` and
        // `tui/chat-orchestrator.ts:293`. Throwing here also caused the
        // outer CLI catch to drop the JSON status block, hiding
        // sessionId from the eval harness — the very symptom we are
        // fixing here. `cancelled` and `failed` are both classified
        // terminations; only programming bugs or unclassified errors
        // should ever bubble past this point.
        state = { ...state, status: "failed", lastError: runError.message };
        this.deps.onEvent?.({ type: "loop_completed", reason: "failed" });
        state = incrementTurnCount(state);
        const durationMs = Date.now() - turnStartedAt;
        this.deps.onEvent?.({
          type: "turn_finished",
          turnIndex,
          reason: "failed",
          stepCount: stepsTaken,
          durationMs,
        });
        // Phase 6 — bump failure_count for every surfaced lesson.
        // `cancelled` is intentionally NOT routed here; that branch
        // returned earlier without calling the hook (cancellation
        // carries neither success nor failure signal).
        invokeLessonLifecycle(this.deps, state.id, surfacedLessonIds, "failure");
        return {
          session: state,
          reason: "failed",
          stepCount: stepsTaken,
          undelivered: this.flushSteering(state.id),
        };
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

    // Phase 6 — bump success/failure counters on surfaced lessons.
    // `reply` / `finish` are positive outcomes; `cancelled` /
    // `max_steps` are filtered out (neither a success nor failure
    // signal). The `failed` branch already fired the hook above
    // before its early `return`.
    if (reason === "reply" || reason === "finish") {
      invokeLessonLifecycle(this.deps, state.id, surfacedLessonIds, "success");
    }

    // Fire async memory reflection. Never awaited — the runner
    // swallows its own errors; the loop stays decoupled from
    // memory-formation latency.
    //
    // Legacy (segmentation disabled): fire on `reason === "reply"`
    // when a user message arrived this turn, using a single
    // user/assistant pair.
    //
    // Segmentation enabled (v2.5 Phase B):
    //   - On `reply`: fire iff `state.turnCount % triggerEveryTurns
    //     === 0` (cadence gate).
    //   - On `finish`: fire unconditionally — final flush so the
    //     trailing partial window is never lost.
    //   - Pack the last `windowTurns` user/assistant pairs into
    //     `ReflectionInput.transcript`. The trailing pair's content
    //     is also mirrored into `userMessage`/`assistantReply` so
    //     the runner contract stays satisfied.
    if (
      this.deps.reflectionRunner &&
      (reason === "reply" || reason === "finish")
    ) {
      const segmentation = this.deps.reflectionSegmentation;
      const segmentationActive =
        segmentation?.enabled === true &&
        segmentation.triggerEveryTurns >= 1 &&
        segmentation.windowTurns >= 1;
      const shouldFire = segmentationActive
        ? reason === "finish" ||
          (reason === "reply" &&
            state.turnCount > 0 &&
            state.turnCount % segmentation!.triggerEveryTurns === 0)
        : reason === "reply" && options.userMessage !== undefined;
      if (shouldFire) {
        const transcript = segmentationActive
          ? collectLastUserAssistantPairs(state, segmentation!.windowTurns)
          : [];
        const trailingPair =
          transcript.length > 0 ? transcript[transcript.length - 1] : null;
        const userMessage = segmentationActive
          ? (trailingPair?.user ?? options.userMessage ?? null)
          : (options.userMessage ?? null);
        const assistantReply = segmentationActive
          ? (trailingPair?.assistant ?? findLastAssistantReply(state))
          : findLastAssistantReply(state);
        // Skip when we genuinely have nothing to extract from
        // (e.g. a `finish`-only session without a user/assistant
        // pair). The runner contract requires non-null
        // `userMessage` / `assistantReply`.
        if (userMessage !== null && assistantReply !== null) {
          // Memory-v2 phase 7a. The allowlist for the vote-runner
          // is the union of (notes recalled this turn) ∪ (lessons
          // recalled across all steps of this turn) ∪ (profile
          // facts currently active). Profile facts are not gated
          // by recall — they're always candidates because the
          // renderer already surfaces them whenever they pass the
          // contextual-keyword gate. Sourcing them here keeps the
          // decorator's hydration cheap.
          const profileFacts =
            this.deps.profileFactsProvider?.() ?? [];
          void this.deps.reflectionRunner.reflect({
            sessionId: state.id,
            userMessage,
            assistantReply,
            // Memory-v2 phase 2. Surfaced ids for this turn — the
            // allowlist for the link-generator sub-call. Empty /
            // undefined when memory.notes is disabled OR no recall
            // was performed.
            ...(state.recalledNotes && state.recalledNotes.length > 0
              ? { recalledMemoryIds: state.recalledNotes.map((n) => n.id) }
              : {}),
            // Memory-v2 phase 7a. Allowlist for the vote-runner —
            // every lesson surfaced through any step of this turn,
            // every profile fact currently active.
            ...(surfacedLessonIds.size > 0
              ? { recalledLessonIds: Array.from(surfacedLessonIds) }
              : {}),
            ...(surfacedProcedureIds.size > 0
              ? { recalledProcedureIds: Array.from(surfacedProcedureIds) }
              : {}),
            ...(profileFacts.length > 0
              ? {
                  recalledProfileFactIds: profileFacts
                    .map((f) => f.id)
                    .filter((id): id is number => typeof id === "number"),
                }
              : {}),
            turnIndex: state.turns.length,
            // v2.5 (Phase B). Multi-turn window
            // is only attached when segmentation is active —
            // otherwise the runner falls back to the byte-stable
            // single-pair prompt.
            ...(segmentationActive && transcript.length > 0
              ? { transcript }
              : {}),
          });
        }
      }
    }

    return {
      session: state,
      reason,
      stepCount: stepsTaken,
      undelivered: this.flushSteering(state.id),
    };
  }

  /**
   * Close the steering window and empty the inbox on the way out of a
   * turn — one indivisible step, which is the whole point.
   *
   * A message pushed after the loop's last drain — during the final
   * inference, or at any point in a turn that was cancelled before it
   * stepped — would otherwise sit in the inbox until some unrelated
   * later turn happened to pick it up, out of order and out of context.
   * What is already pending is handed back to the caller as
   * `undelivered`; what arrives from here on is refused at `push`, so
   * the sender learns immediately that it was not steered. Together
   * that keeps "the message you sent always goes somewhere" true on
   * every exit path, with no window in between.
   */
  private flushSteering(sessionId: string): readonly string[] {
    return this.deps.steeringInbox?.closeAndDrain(sessionId) ?? [];
  }
}

/**
 * Phase 6 — fire the lesson lifecycle hook exactly once with the
 * de-duplicated set of surfaced ids. Empty set or missing hook is a
 * silent no-op. Hook errors are swallowed so a sqlite hiccup never
 * derails the agent-loop return path.
 */
function invokeLessonLifecycle(
  deps: AgentLoopDependencies,
  sessionId: string,
  surfacedIds: ReadonlySet<number>,
  outcome: LessonLifecycleOutcome,
): void {
  const hook = deps.lessonLifecycle;
  if (!hook) return;
  if (surfacedIds.size === 0) return;
  try {
    hook.recordTurnOutcome({
      sessionId,
      surfacedLessonIds: Array.from(surfacedIds),
      outcome,
    });
  } catch (err) {
    deps.logger?.warn?.("lesson lifecycle hook failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function findLastAssistantReply(state: SessionState): string | null {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const turn = state.turns[i];
    if (turn?.kind === "assistant_reply") return turn.text;
  }
  return null;
}

async function refreshMemoryContext(
  deps: AgentLoopDependencies,
  state: SessionState,
  options: RunTurnOptions,
): Promise<SessionState> {
  if (!deps.memoryContextProvider) return state;
  try {
    const ctx = await deps.memoryContextProvider.buildMemoryContext({
      sessionId: state.id,
      userMessage: options.userMessage ?? null,
      toolResultSummaries: collectRecentToolResultSummaries(state),
      // v2.5 (Phase A). Project the session's
      // existing `user`/`assistant_reply` turns into the shape the
      // rewriter decorator expects. The current user message lives
      // in `userMessage` above, so we exclude it from this list to
      // keep semantics clean: `recentTurns` is "history BEFORE this
      // turn's user message". The agent loop has already appended
      // the current user turn to `state.turns` at this point, so we
      // drop the trailing user row whose `text` matches.
      recentTurns: collectRecentUserAssistantTurns(state, options.userMessage),
      signal: options.signal,
    });
    const lessons = ctx.lessons ?? [];
    if (lessons.length > 0) {
      deps.metrics?.recordLessonsRecalled({
        sessionId: state.id,
        hits: lessons.length,
      });
    }
    const procedures = ctx.procedures ?? [];
    if (procedures.length > 0) {
      deps.metrics?.recordProceduresRecalled({
        sessionId: state.id,
        hits: procedures.length,
      });
    }
    return {
      ...state,
      recalledNotes: ctx.recalled,
      memoryIndex: ctx.index,
      recalledLessons: lessons,
      recalledProcedures: procedures,
    };
  } catch (err) {
    deps.logger?.warn("memory context provider failed", {
      sessionId: state.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return state;
  }
}

function collectRecentToolResultSummaries(
  state: SessionState,
  maxEntries = 4,
): string[] {
  const summaries: string[] = [];
  for (let i = state.turns.length - 1; i >= 0 && summaries.length < maxEntries; i -= 1) {
    const turn = state.turns[i];
    if (turn?.kind !== "tool_result") continue;
    summaries.push(`${turn.tool}: ${turn.summary}`);
  }
  return summaries.reverse();
}

/**
 * v2.5 (Phase A). Walk the session backwards and
 * collect the trailing `user` / `assistant_reply` rows in
 * chronological order. Excludes the just-arrived user message
 * (matched against `currentUserMessage`) so the rewriter's history
 * never contains the message it is being asked to rewrite. The cap
 * is intentionally generous so a long-context decorator (e.g. a
 * future segmentation-aware rewriter) can use a wider window without
 * a second pass.
 */
const RECENT_TURN_PROJECTION_CAP = 12;

/**
 * v2.5 (Phase B). Walk the session backwards and
 * collect the trailing user/assistant pairs in chronological order
 * for the segmentation-aware reflection window. A "pair" is a `user`
 * row followed by the next `assistant_reply` row in the conversation.
 * Intervening tool calls / results are ignored — the reflection
 * prompt only consumes the human/agent text.
 *
 * Returns up to `windowTurns` pairs in chronological order (oldest
 * first). When the trailing turn has a `user` row without an
 * `assistant_reply` (e.g. the model emitted `finish` before
 * replying), that orphan pair is dropped so every entry in the
 * window is complete.
 */
function collectLastUserAssistantPairs(
  state: SessionState,
  windowTurns: number,
): { user: string; assistant: string }[] {
  if (windowTurns <= 0) return [];
  // Walk forward to produce stable pair boundaries: each `user` row
  // owns the *next* `assistant_reply` row that follows it (if any).
  const pairs: { user: string; assistant: string }[] = [];
  let pendingUser: string | null = null;
  for (const turn of state.turns) {
    if (!turn) continue;
    if (turn.kind === "user") {
      // Consecutive user rows exist since mid-turn steering: the steer
      // must not REPLACE the founding message in the reflection pair —
      // memory extraction would then attribute the whole turn to the
      // correction alone. Join them in order instead.
      pendingUser = pendingUser === null ? turn.text : `${pendingUser}\n\n${turn.text}`;
    } else if (turn.kind === "assistant_reply" && pendingUser !== null) {
      pairs.push({ user: pendingUser, assistant: turn.text });
      pendingUser = null;
    }
  }
  if (pairs.length <= windowTurns) return pairs;
  return pairs.slice(pairs.length - windowTurns);
}

function collectRecentUserAssistantTurns(
  state: SessionState,
  currentUserMessage: string | undefined,
): { role: "user" | "assistant"; text: string }[] {
  const rows: { role: "user" | "assistant"; text: string }[] = [];
  for (
    let i = state.turns.length - 1;
    i >= 0 && rows.length < RECENT_TURN_PROJECTION_CAP;
    i -= 1
  ) {
    const turn = state.turns[i];
    if (!turn) continue;
    if (turn.kind === "user") {
      // Skip the trailing user row that mirrors `currentUserMessage`
      // — the rewriter consumes that via `MemoryContextProviderInput.userMessage`.
      if (
        rows.length === 0 &&
        currentUserMessage !== undefined &&
        turn.text === currentUserMessage
      ) {
        continue;
      }
      rows.push({ role: "user", text: turn.text });
    } else if (turn.kind === "assistant_reply") {
      rows.push({ role: "assistant", text: turn.text });
    }
  }
  return rows.reverse();
}
