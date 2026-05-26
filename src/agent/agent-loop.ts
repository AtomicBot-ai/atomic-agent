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
  ModelError,
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
import { LoopDetector, formatRepeatNotice } from "./loop-detector.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

export interface AgentLoopDependencies {
  registry: ToolRegistry;
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
  /** Defaults to `grammar` when omitted (test / legacy wiring). */
  toolTransport?: ToolCallTransport;
  toolCallAdapter?: ToolCallAdapter | null;
  supportsSlotAffinity?: boolean;
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

/**
 * Hard upper bound on the number of `loop_detected` notices we tolerate
 * in a single turn before aborting. The first hint injects a `### notice`
 * and gives the model a fresh step to break the loop; further hints
 * indicate the model is genuinely stuck and additional iterations would
 * just burn daemon slot time. With the default detector threshold of 3
 * consecutive identical observations, `2` corresponds to ~6 wasted steps
 * before the turn is cut.
 */
const LOOP_ABORT_AFTER_HINTS = 2;

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
    const loopDetector = new LoopDetector();
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
    // Number of times the loop detector has fired in this turn. The first
    // fire injects a `### notice` and lets the model try to break out;
    // subsequent fires escalate (see `LOOP_ABORT_AFTER_HINTS`). Reset only
    // when a non-repeat observation breaks the run inside the detector.
    let loopHintCount = 0;

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
      const noticeForThisStep = pendingNotice;
      pendingNotice = undefined;
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
            toolDescriptors: this.deps.toolDescriptors,
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            stepIndex: i,
            signal: options.signal,
            ...(noticeForThisStep !== undefined
              ? { transientNotice: noticeForThisStep }
              : {}),
            ...(profileFacts !== undefined ? { profileFacts } : {}),
            ...(options.userMessage !== undefined
              ? { userMessage: options.userMessage }
              : {}),
          },
          {
            registry: this.deps.registry,
            slotManager: this.deps.slotManager,
            grammar: activeGrammar,
            profile: activeProfile,
            toolTransport: this.deps.toolTransport ?? "grammar",
            toolCallAdapter: this.deps.toolCallAdapter ?? null,
            supportsSlotAffinity: this.deps.supportsSlotAffinity ?? true,
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
        // loop-detector path below may overwrite this with a repeat
        // notice — that is intentional: a loop hint outranks a trim
        // hint since the loop indicates the model failed to make
        // progress over multiple steps.
        if (outcome.trimmedBatchNotice !== undefined) {
          pendingNotice = outcome.trimmedBatchNotice;
        }
        // Feed the detector AFTER terminal checks so `reply`/`finish` never
        // trigger a hint (those steps legitimately look identical to the
        // previous tool output). Batched steps feed the composite hash
        // path so two identical batches in a row are detected, but a
        // permuted batch is not.
        const verdict =
          outcome.toolCalls.length > 1
            ? loopDetector.observe({
                tool: "<batch>",
                args: undefined,
                resultSummary: "",
                worldDigest: state.worldSnapshot?.digest ?? null,
                batchCalls: outcome.toolCalls.map((call, idx) => ({
                  tool: call.tool,
                  args: call.args,
                  resultSummary: outcome.toolResults[idx]!.summary,
                })),
              })
            : loopDetector.observe({
                tool: outcome.toolCalls[0]!.tool,
                args: outcome.toolCalls[0]!.args,
                resultSummary: outcome.toolResults[0]!.summary,
                worldDigest: state.worldSnapshot?.digest ?? null,
              });
        if (verdict.kind === "repeat") {
          pendingNotice = formatRepeatNotice(verdict);
          loopHintCount += 1;
          this.deps.logger?.warn("no-progress loop detected", {
            sessionId: state.id,
            stepIndex: i,
            tool: verdict.tool,
            count: verdict.count,
            hintCount: loopHintCount,
          });
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: verdict.tool,
            count: verdict.count,
            stepIndex: i,
          });
          if (loopHintCount >= LOOP_ABORT_AFTER_HINTS) {
            // The detector has fired `LOOP_ABORT_AFTER_HINTS` times in
            // this turn without the model changing behaviour. Each fire
            // already injected a `### notice` and gave the model a fresh
            // step to react, so further iterations would just burn
            // daemon slot time and step budget without progress. Throw a
            // `ModelError` ("no_stop" — the model failed to terminate
            // its sequence) so the existing failure path emits
            // `loop_failed`, marks the session `failed`, frees the slot
            // immediately, and lets the eval harness / CLI surface a
            // clean exit instead of a 15+-step disaster.
            throw new ModelError(
              "no_stop",
              `no-progress loop: \`${verdict.tool}\` repeated identically across ${loopHintCount} hint cycles (${verdict.count} consecutive observations in the latest run); abandoning turn.`,
            );
          }
        }
        state = await refreshMemoryContext(this.deps, state, options);
        recordSurfacedLessons(state);
        recordSurfacedProcedures(state);
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
        return { session: state, reason: "failed", stepCount: stepsTaken };
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

    return { session: state, reason, stepCount: stepsTaken };
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
      pendingUser = turn.text;
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
