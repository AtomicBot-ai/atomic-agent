import { readContextLengthFromRejection } from "../llm/reliability/request-size-rejection.js";
import { resolveModelMode } from "../llm/model-mode.js";
import { prepareStepPrompt } from "./step/step-inference.js";
import type { StepContext, StepDependencies } from "./step/step-contract.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { contextCompactionRejection } from "./turn/compaction-recovery.js";
import { createTurnLoopState } from "./turn/turn-state.js";
import { recoverTurnStep, abortableSleep } from "./turn/turn-recovery.js";
import type { AgentLoopDependencies, RunTurnOptions, RunTurnResult } from "./agent-contract.js";
export type { AgentLoopDependencies, ReflectionSegmentationConfig, ResolvedTurnLlmSlice, MemoryContextProviderInput, MemoryContext, MemoryContextProvider, LessonLifecycleOutcome, LessonLifecycleHook, SteeringChannel, TaskStopCause, RunTurnOptions, AgentLoopReason, AgentLoopEvent, RunTurnResult } from "./agent-contract.js";
import { prepareAgentTurn, prepareTurnPolicies, prepareTurnBudgets, createTurnLoopTracker } from "./turn/turn-preparation.js";
import { refreshMemoryContext, createSurfacedMemoryTracker } from "./turn/turn-memory-context.js";
export { MAX_SURFACED_NOTE_ALLOWLIST } from "./turn/turn-memory-context.js";
import { finalizeAgentTurn, finalizeFailedAgentTurn } from "./turn/turn-finalization.js";
export { formatTaskStoppedReply } from "./turn/turn-finalization.js";
import { delegationProducedWork, recordDelegation, wouldRefuse as fusionGateWouldRefuse } from "./policies/fusion-orchestrator-mode.js";
import { observeReviewStep, reviewStallSignal, reviewStallToolSet, takeReviewStallNotice, type ReviewStallSignal } from "./review-stall.js";

import type { CompletionResult } from "../llm/llama-server-client.js";

import type { ToolCallTransport } from "../llm/provider/completion-types.js";

import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";

import type { SessionState } from "../session/session-state.js";
import { recordTurn } from "../session/session-state.js";
import { assistantReplyTurn, steeredUserTurn } from "../session/conversation-turn.js";
import { formatProgressNoteStepSummary, isProgressNoteResult } from "./progress-note-reply.js";

import type { ProfileFact } from "../memory/profile-store.js";

import { executeStep } from "./step-executor.js";
import {
  FINALIZATION_REQUEST_DEADLINE_MS,
  createRequestDeadline,
} from "./request-deadline.js";

import { OUTCOME_REPEAT_WARNING_THRESHOLD, READ_REPEAT_WARNING_THRESHOLD, TEST_REPEAT_WARNING_THRESHOLD } from "./progress/loop-constants.js";
import { formatOutcomeRepeatNotice, formatReadRepeatNotice, formatRepeatNotice, formatTestRepeatNotice, formatWanderingRedirect, formatForcedLoopReply } from "./progress/loop-notices.js";
import type { BatchLoopSignal } from "./dispatch/batch-contract.js";
import { composeSteerNotice } from "./steer-notice.js";

import { getConfig } from "../config/index.js";

import { ProfileClipWarnings, reportProfileClip } from "./profile-clip-warning.js";

/**
 * What the user reads when the step loop ran out before the model
 * finished the task.
 *
 * The old text was `(stopped: max_steps reached without a reply)` — a
 * parenthetical naming an internal counter, offering nothing. Someone
 * watching a browser job stop after three minutes had no way to tell a
 * crash from a budget, and nothing to do about it but retype the task,
 * which starts it over. This says which ceiling was hit, how far the
 * work got, and that "continue" resumes from here rather than restarts.
 */

export class AgentLoop {
  /** Once-per-session dedupe for the `### profile` clip warning. */
  private readonly profileClipWarnings = new ProfileClipWarnings();

  constructor(private readonly deps: AgentLoopDependencies) {}

  /**
   * Whether the local llama-server is the route this turn takes. No gate
   * wired (test / legacy deps) reads as `true` so the profile manager
   * behaves exactly as it did before issue #112.
   */
  private localBackendActive(): boolean {
    return this.deps.localBackend?.isActive() ?? true;
  }

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
    this.deps.compaction?.open(session.id, options.signal);
    // Like the fan-out grant: forgotten when a turn starts rather than
    // when it ends, so an aborted turn cannot carry a no into the next.
    this.deps.forgetDeclinedApprovals?.(session.id);
    try {
      return await this.runTurnInner(session, options);
    } finally {
      this.deps.compaction?.close(session.id);
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
    const preparedTurn = prepareAgentTurn(session, options, this.deps);
    let state = preparedTurn.state;
    const {
      resumesStoppedTask, turnIndex, turnStartedAt, pinnedSlice, visibleToolDescriptors,
    } = preparedTurn;
    state = await refreshMemoryContext(this.deps, state, options);
    await preparedTurn.profileSynced;
    const policies = prepareTurnPolicies(session.id, options, this.deps);
    const { fusionOrchestratorTurn, toolRole, claimEvidence, linkEvidence, progressNotes } = policies;
    let { fusionState, reviewStall } = policies;
    const turn = createTurnLoopState();
    let overflowCompactionAttempted = false;
    const { legSteps, stepCeiling, durationCeilingMs, taskStartedAt } =
      prepareTurnBudgets(options);
    // Provider-outage parking. A transport failure means "this link is
    // not answering", which is a state of the world, not a verdict on
    // the turn — so the turn waits for it rather than dying and taking
    // the work in flight with it. Reset after a recovery so a second
    // outage later in a long task gets its own budget; the task's
    // wall-clock ceiling is what bounds the total.
    const providerWaitDefaults = getConfig().agent.providerWait;
    const providerWaitCfg = {
      enabled: options.providerWaitEnabled ?? providerWaitDefaults.enabled,
      maxWaitMs: options.providerWaitMaxMs ?? providerWaitDefaults.maxWaitMs,
    };
    /**
     * Is there a step left for a recovery to actually be spent in?
     *
     * A recovery that "spends a step" is a promise of another
     * inference: the operator is told the turn is trying again, and the
     * failure is dropped on the strength of that. The LEG boundary is
     * the one ceiling that can make that promise entirely false, and it
     * is the one this predicate exists for. A recovery taken on the
     * final step of a leg that has produced nothing usable lands on the
     * `no_progress` break, which leaves the loop before `executeStep`
     * runs again: the announced retry never happens, the step is burnt
     * for nothing, and the model diagnosis is swallowed into "ran out
     * of steps" — taking the error report with it, since only
     * `loop_failed` is captured.
     *
     * The step and duration ceilings are deliberately NOT solved here.
     * The finalization guard preempts a recovery on a step that is
     * already final, but nothing stops one from LANDING on the final
     * step — and there the retry genuinely runs, so refusing it would
     * forfeit a real inference (and, on the last step of a long task,
     * the summary it might still produce). What that case needs is for
     * its failure to be reported instead of swallowed, which is
     * `repeatedEmptyAfterAnnouncedRetry` in the catch below. The
     * `stepCeiling` test that follows is therefore only a floor: it
     * rejects a retry with no step at all left to run in, which the
     * finalization guard already makes unreachable.
     *
     * Reading `legMadeProgress` here is reading exactly what the
     * boundary will read: a recovery cannot set it (it produced nothing
     * usable, by definition), and nothing else runs in between.
     */
    const recoveryStepAvailable = (stepIndex: number): boolean => {
      const next = stepIndex + 1;
      if (next >= stepCeiling) return false;
      const boundaryRuns =
        next > 0 && next % legSteps === 0 && next !== turn.lastBoundaryIndex;
      return !boundaryRuns || turn.legMadeProgress;
    };
    const loopTracker = createTurnLoopTracker();

    const {
      surfacedLessonIds, surfacedProcedureIds, surfacedNoteIds,
      recordSurfacedLessons, recordSurfacedProcedures, recordSurfacedNotes,
    } = createSurfacedMemoryTracker(state);

    state = { ...state, status: "running" };

    // The step loop below is where coding work actually happens. On each
    // step the model sees the freshly built prompt (transcript + tool
    // catalog + memory tail) and either emits tool calls — reading files,
    // editing, running commands through the approval gate — or a terminal
    // `reply`/`finish`. Tool results are appended to the conversation, so
    // the next step's prompt carries everything the previous step learned.
    for (let i = 0; i < stepCeiling; i += 1) {
      if (options.signal.aborted) {
        turn.reason = "cancelled";
        break;
      }
      // Leg boundary. Everything the task needs to keep running is
      // decided here, once per `legSteps` steps, and never mid-leg.
      if (i > 0 && i % legSteps === 0 && i !== turn.lastBoundaryIndex) {
        turn.lastBoundaryIndex = i;
        if (!turn.legMadeProgress) {
          // A whole leg with nothing usable coming back is the honest
          // place to stop: the loop detector's breaker catches a model
          // repeating itself, but not a model whose every call fails.
          turn.stopCause = "no_progress";
          turn.reason = "max_steps";
          break;
        }
        turn.legMadeProgress = false;
        this.deps.onEvent?.({
          type: "task_continued",
          stepsTaken: turn.stepsTaken,
          elapsedMs: Date.now() - taskStartedAt,
          stepCeiling,
        });
        this.deps.logger?.info("task leg finished; continuing", {
          sessionId: state.id,
          stepsTaken: turn.stepsTaken,
          stepCeiling,
          elapsedMs: Date.now() - taskStartedAt,
        });
      }
      // Reactive refresh between steps: if the previous completion
      // observed a foreign `modelId`, rebuild profile + grammar so the
      // next prompt matches what `llama-server` is actually serving.
      // Same cloud-turn gate as the turn-start refresh (issue #112).
      // Nothing is lost on a cloud turn that falls over: the fallback
      // seam's `prepareLink` runs this same `refreshIfStale` for a
      // `llama-server` link at the point the link is picked, which is
      // strictly later than here and strictly closer to the request —
      // the completion that flagged the manager stale may not even have
      // happened yet when this line runs.
      if (this.deps.profileManager && this.localBackendActive()) {
        if (!(await this.deps.localBackend?.ensureProbed())) {
          await this.deps.profileManager.refreshIfStale();
        }
      }
      this.deps.onEvent?.({ type: "step_started", stepIndex: i });
      const started = Date.now();
      // Mid-turn steering: anything the user sent since the previous
      // step boundary joins this step's prompt. It is recorded as a
      // real `user` turn, marked `steered` (the transcript must reflect
      // what was said, and that it joined a turn already under way,
      // and `packConversation` always keeps the last user turn visible)
      // AND repeated in `### notice`, which is the tail-most block the
      // model reads before `### respond`. `composeSteerNotice` appends
      // to whatever the loop detector already left in `pendingNotice`
      // rather than overwriting it — both nudges matter.
      const steered = this.deps.steeringInbox?.drain(state.id) ?? [];
      for (const text of steered) {
        state = recordTurn(state, steeredUserTurn(text));
        this.deps.onEvent?.({ type: "steer_applied", text, stepIndex: i });
      }
      if (steered.length > 0) {
        // A new user instruction may request a call declined earlier.
        this.deps.forgetDeclinedApprovals?.(state.id);
        turn.pendingNotice = composeSteerNotice(turn.pendingNotice, steered);
        this.deps.logger?.info("mid-turn steering applied", {
          sessionId: state.id,
          stepIndex: i,
          count: steered.length,
        });
      }
      let noticeForThisStep = turn.pendingNotice;
      turn.pendingNotice = undefined;
      // On the final allowed step only the two terminal tools may run, so
      // a long coding session ends with a summary of what was changed
      // instead of being cut off mid-edit. The catalog in the prompt is
      // NOT narrowed for it: `### tools` is stable-prefix bytes, and a
      // narrowed catalog moved the session to a cold slot for its last
      // step. The restriction travels as `terminalOnly` — the batch
      // executor answers a non-terminal call with a refusal, and the
      // local grammar is built from the same flag.
      // One step is always reserved for a summary, whichever ceiling is
      // about to bite — being cut off mid-edit is what made the old
      // stop unreadable.
      const elapsedMs = Date.now() - taskStartedAt;
      const outOfTime =
        turn.ceilingFiredMidRequest || elapsedMs >= durationCeilingMs;
      if (outOfTime) turn.stopCause = "time_ceiling";
      const finalizationStep = i === stepCeiling - 1 || outOfTime;
      // The stalled-review phase this step runs under, read before the
      // prompt is built (`review-stall.ts`): the notice joins the step's
      // `### notice` — inside `noticeForThisStep`, so a retry of the
      // step carries it like every other notice — and the cut narrows
      // the step's tool set. Not on the reserved final step, which is
      // narrower already.
      let stallSignal: ReviewStallSignal | null = null;
      if (reviewStall !== null && !finalizationStep) {
        stallSignal = reviewStallSignal(reviewStall);
        if (stallSignal !== null) {
          const taken = takeReviewStallNotice(reviewStall, stallSignal);
          reviewStall = taken.state;
          if (taken.notice !== null) {
            noticeForThisStep =
              noticeForThisStep === undefined
                ? taken.notice
                : `${noticeForThisStep}\n\n${taken.notice}`;
            this.deps.logger?.info("fusion review stalled", {
              sessionId: state.id,
              stepIndex: i,
              readOnlySteps: stallSignal.steps,
              phase: stallSignal.phase,
            });
          }
        }
      }
      const effectiveTransport: ToolCallTransport =
        pinnedSlice?.toolTransport ?? this.deps.toolTransport ?? "grammar";
      const finalizationNotice =
        "This is the final allowed step. Do not call any non-terminal tool; " +
        "summarize the completed work with reply, or end the session with finish.";
      // The ceiling holds while waiting on a provider: the step's
      // completion request gets the task's remaining time as a deadline
      // (composed with the user's signal), so a turn parked in a queue
      // or a long prompt evaluation cannot run past its window. The
      // summary step gets at least its own five minutes — it is
      // reserved whichever ceiling bit, and llama-server keeps decoding
      // the abandoned request until it notices the closed connection.
      const requestDeadline = createRequestDeadline(
        options.signal,
        finalizationStep
          ? Math.max(
              durationCeilingMs - elapsedMs,
              FINALIZATION_REQUEST_DEADLINE_MS,
            )
          : durationCeilingMs - elapsedMs,
      );
      let compactionInput: BuildPromptInput | undefined;
      try {
        // `profileFactsProvider` is a raw `profileStore.listForPrompt()`.
        // Dropping the facts is a real loss — `profile-renderer` emits
        // pinned facts regardless of the contextual gate, so this step
        // renders with no `### profile` section at all — but it is the
        // lesser one: a throw here lands in the
        // catch below, where a `TypeError` from a closed SQLite handle
        // classifies `tool` and fails the turn outright.
        let profileFacts: readonly ProfileFact[] | undefined;
        try {
          profileFacts = this.deps.profileFactsProvider?.();
        } catch (err) {
          this.deps.logger?.warn("profile facts unavailable for this step", {
            sessionId: state.id,
            stepIndex: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const activeProfile =
          this.deps.profileManager?.getProfile() ??
          this.deps.profile ??
          PLAIN_INSTRUCT_PROFILE;
        const activeGrammar =
          this.deps.profileManager?.getGrammar() ?? this.deps.grammar;
        const stepContext: StepContext = {
            session: state,
            toolDescriptors: visibleToolDescriptors(),
            capabilities: this.deps.capabilities,
            skillCatalog: this.deps.skillCatalog,
            ...(this.deps.skillCatalogDropped !== undefined
              ? { skillCatalogDropped: this.deps.skillCatalogDropped }
              : {}),
            stepIndex: i,
            signal: options.signal,
            requestSignal: requestDeadline.signal,
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
            ...(stallSignal?.phase === "cut"
              ? { toolSet: reviewStallToolSet() }
              : {}),
            ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
            toolRole,
            ...(turn.truncationRetry?.stepIndex === i &&
            turn.truncationRetry.maxTokens !== undefined
              ? { maxTokens: turn.truncationRetry.maxTokens }
              : {}),
            ...(profileFacts !== undefined ? { profileFacts } : {}),
            ...(options.userMessage !== undefined
              ? { userMessage: options.userMessage }
              : {}),
            ...(options.originalRequest !== undefined
              ? { originalRequest: options.originalRequest }
              : {}),
            ...(options.routeNote !== undefined
              ? { routeNote: options.routeNote }
              : {}),
            ...(options.reasoningEffort !== undefined
              ? { reasoningEffort: options.reasoningEffort }
              : {}),
            ...(options.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.maxOutputTokens }
              : {}),
          };
        const contextProviderId = options.providerId ?? this.deps.contextProviderId?.(state.id);
        const initialMode = options.modelModePolicy ? resolveModelMode(options.modelModePolicy, options.providerId) : undefined;
        const modelMode = options.modelModePolicy ? resolveModelMode(options.modelModePolicy, contextProviderId) : undefined;
        // Cloud transitions must use the sticky link before planning maintenance,
        // not only at send time. All-local preparation retains its existing path.
        const contextSlice = contextProviderId && (initialMode?.mode === "cloud" || modelMode?.mode === "cloud")
          ? this.deps.resolveLlmSlice?.(contextProviderId) ?? pinnedSlice : pinnedSlice;
        const stepDeps: StepDependencies = {
            registry: this.deps.registry,
            commitSession: (next) => {
              state = next;
              stepContext.session = next;
              if (!options.ephemeral) this.deps.persistContext?.(next);
            },
            ...(this.deps.isPlanMode
              ? { isPlanMode: this.deps.isPlanMode }
              : {}),
            ...(this.deps.approvalPosture
              ? { approvalPosture: this.deps.approvalPosture }
              : {}),
            ...(fusionOrchestratorTurn
              ? {
                  isFusionOrchestrator: () => true,
                  fusionState: () => fusionState,
                  onDelegated: (result) => {
                    fusionState = recordDelegation(
                      fusionState,
                      delegationProducedWork(result),
                    );
                  },
                }
              : {}),
            claimEvidence,
            linkEvidence,
            progressNotes,
            slotManager: this.deps.slotManager,
            grammar: activeGrammar,
            profile: activeProfile,
            ...(contextSlice?.contextWindow !== undefined || this.deps.contextWindow
              ? { contextWindow: contextSlice?.contextWindow !== undefined ? contextSlice.contextWindow : this.deps.contextWindow?.() ?? null }
              : {}),
            // The `/props` profile describes the local llama-server. It
            // is the right window only when this step is routed there:
            // a pinned turn answers from its own link, an unpinned one
            // from the active provider. In Fusion those differ, and
            // budgeting a cloud orchestrator against the workers'
            // per-slot `n_ctx` packed a 128k model to 16k.
            profileWindowApplies:
              contextSlice?.isLlamaServer ?? this.localBackendActive(),
            ...(this.deps.liveWorkerSlots
              ? { liveWorkerSlots: this.deps.liveWorkerSlots }
              : {}),
            toolTransport: contextSlice?.toolTransport ?? effectiveTransport,
            ...(options.modelModePolicy ? {
              modelModePolicy: options.modelModePolicy,
              modelMode,
            } : {}),
            toolCallAdapter:
              contextSlice?.toolCallAdapter ?? this.deps.toolCallAdapter ?? null,
            supportsSlotAffinity:
              contextSlice?.supportsSlotAffinity ??
              this.deps.supportsSlotAffinity ??
              true,
            supportsParallelTools:
              contextSlice?.supportsParallelTools ??
              this.deps.supportsParallelTools ??
              true,
            strictTools:
              contextSlice?.strictTools ?? this.deps.strictTools ?? false,
            ...(options.providerId !== undefined
              ? { providerId: options.providerId }
              : {}),
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
                  fusionTokensPerSecond: () =>
                    this.deps.profileManager?.getTokensPerSecond() ?? null,
                }
              : {}),
            onEvent: (event) => {
              this.deps.onEvent?.({ type: "llm_event", event });
              if (event.type === "prompt_built") {
                turn.lastPromptTokens = event.prompt.tokens.total;
                if (event.prompt.cloudContext && state.cloudContext !== event.prompt.cloudContext) {
                  state = { ...state, cloudContext: event.prompt.cloudContext };
                  stepContext.session = state;
                  if (!options.ephemeral) this.deps.persistContext?.(state);
                }
              }
              // Issue #407. Skipped on a fusion worker's throwaway
              // session: it renders the same store as the orchestrator,
              // which already warned, and would repeat it per worker.
              if (event.type === "prompt_built" && options.ephemeral !== true) {
                reportProfileClip({
                  warnings: this.profileClipWarnings,
                  sessionId: state.id,
                  stepIndex: i,
                  clip: event.prompt.profileClip,
                  ...(this.deps.logger ? { logger: this.deps.logger } : {}),
                  emit: (clipped) => this.deps.onEvent?.(clipped),
                });
              }
            },
            ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
            ...(this.deps.logger ? { logger: this.deps.logger } : {}),
            tracker: loopTracker,
          };
        if (this.deps.compaction) {
          compactionInput = prepareStepPrompt(stepContext, stepDeps).promptInput;
          let maintenance = this.deps.compaction.beforeStep(compactionInput, {
            signal: requestDeadline.signal,
            ...(options.providerId ? { providerId: options.providerId } : {}),
            ...(options.ephemeral ? { ephemeral: true } : {}),
          });
          while (maintenance) {
            state = await maintenance;
            // Messages arriving during summarization join this inference, not the next one.
            const late = this.deps.steeringInbox?.drain(state.id) ?? [];
            for (const text of late) {
              state = recordTurn(state, steeredUserTurn(text));
              this.deps.onEvent?.({ type: "steer_applied", text, stepIndex: i });
            }
            if (late.length) {
              this.deps.forgetDeclinedApprovals?.(state.id);
              stepContext.transientNotice = composeSteerNotice(stepContext.transientNotice, late);
            }
            stepContext.session = state;
            if (!late.length) break;
            compactionInput = prepareStepPrompt(stepContext, stepDeps).promptInput;
            maintenance = this.deps.compaction.beforeStep(compactionInput, {
              signal: requestDeadline.signal,
              ...(options.providerId ? { providerId: options.providerId } : {}),
              ...(options.ephemeral ? { ephemeral: true } : {}),
            });
          }
        }
        const outcome = await executeStep(stepContext, stepDeps);
        requestDeadline.dispose();
        const durationMs = Date.now() - started;
        if (turn.awaitingRecovery) {
          // The step that came back after the wait. Say so once, then
          // hand the next outage a fresh budget.
          this.deps.onEvent?.({
            type: "provider_recovered",
            waitedMs: turn.outageWaitedMs,
          });
          this.deps.logger?.info("provider answered again; turn resumed", {
            sessionId: state.id,
            stepIndex: i,
            waitedMs: turn.outageWaitedMs,
          });
          turn.awaitingRecovery = false;
          turn.outageWaitedMs = 0;
          turn.outageAttempts = 0;
        }
        state = outcome.nextSession;
        turn.stepsTaken += 1;
        // A completed step is what the review-stall count observes: a
        // fan-out resets it, a step of reading (or of refusals) adds
        // one. The mutation predicate is the orchestrator gate's own.
        if (reviewStall !== null) {
          reviewStall = observeReviewStep(reviewStall, {
            results: outcome.toolResults,
            mutates: (tool) =>
              fusionGateWouldRefuse(tool, { registry: this.deps.registry }),
          });
        }
        // A completion the step could act on. Whatever run of empty
        // completions was in progress is over: the link has just proved
        // it answers, so an empty one later in this turn is a fresh
        // event and is owed its own retry, and the terminal message can
        // keep saying "twice in a row" and mean it.
        turn.emptyRecoveries = 0;
        const tokensUsed =
          (outcome.completion.timing?.promptTokens ??
            outcome.prompt.tokens.total) +
          (outcome.completion.timing?.predictedTokens ?? 0);
        // The server just held more than the runtime thought it could:
        // a learned window was wrong, and packing to it would only
        // throw context away.
        const believedWindow = this.deps.contextWindow?.() ?? null;
        const usage = outcome.completion.usage;
        if (
          usage !== undefined &&
          believedWindow !== null &&
          usage.promptTokens + usage.completionTokens > believedWindow
        ) {
          this.deps.onContextWindowExceeded?.(
            usage.promptTokens + usage.completionTokens,
          );
        }
        // Step-level outcome rolls up batched results: any failed call
        // marks the step as `error` so metrics catch partial failures.
        const stepStatus: "ok" | "error" = outcome.toolResults.some(
          (r) => r.status === "error",
        )
          ? "error"
          : "ok";
        // Progress for the leg check is "something usable came back",
        // not "the step was clean": a batch where three calls of four
        // succeeded moved the task forward. What it excludes is a leg
        // whose every call failed — a dead tool, a dead network, a
        // rejected approval loop — which is the case worth stopping on.
        // A progress note is a kept reply, not a tool that ran, so it
        // is not the evidence this check is after.
        if (
          outcome.toolResults.some(
            (r) => r.status === "ok" && !isProgressNoteResult(r),
          )
        ) {
          turn.legMadeProgress = true;
        }
        // Feed summary mirrors the legacy single-call shape for solo
        // steps; for a batch we render `N tools: t1, t2, …` so the TUI
        // and trace consumer see at a glance that this was a batch. A
        // step that kept a progress note says so.
        const summary =
          outcome.progressNote !== undefined
            ? formatProgressNoteStepSummary(outcome.toolResults)
            : outcome.toolResults.length === 1
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
          ...(outcome.progressNote !== undefined ? { progressNote: true } : {}),
          ...(stallSignal !== null ? { reviewStall: stallSignal } : {}),
        });
        if (outcome.terminal === "session") {
          turn.reason = "finish";
          turn.endedOnFinalizationStep = finalizationStep;
          state = { ...state, status: "completed" };
          break;
        }
        if (outcome.terminal === "turn") {
          turn.reason = "reply";
          turn.endedOnFinalizationStep = finalizationStep;
          break;
        }
        // The reserved final step ran and the model still did not close
        // the turn: its non-terminal calls were refused at dispatch
        // (`final step: only reply or finish run here`), nothing more
        // may execute, and the ceiling that made the step final is what
        // ends the turn — `stopCause` already names it.
        if (finalizationStep) {
          turn.reason = "max_steps";
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
          turn.pendingNotice = outcome.trimmedBatchNotice;
        } else if (outcome.waveSplitNotice !== undefined) {
          turn.pendingNotice = outcome.waveSplitNotice;
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

        // Breaker: the model ignored repeated vetoes of the same call, or
        // a wandering spread crossed the escalation cap.
        // Force a graceful synthetic reply (NOT a `loop_failed` — the
        // turn ends with a best-effort answer, the session stays usable).
        const breaker = loopSignals.find((s) => s.kind === "breaker");
        if (breaker) {
          const replyText = formatForcedLoopReply(
            breaker.tool,
            breaker.count,
            breaker.detector,
            breaker.blockedCount,
          );
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
            "loop breaker tripped; forcing graceful reply",
            {
              sessionId: state.id,
              stepIndex: i,
              tool: breaker.tool,
              count: breaker.count,
              detector: breaker.detector,
            },
          );
          turn.reason = "reply";
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
          // Two detectors carry their own floor because their signal is
          // conclusive earlier than a byte-identical repeat is. A 2nd
          // test run against an unchanged workspace cannot produce new
          // evidence; a 2nd consecutive read of an unchanged file that
          // returned nothing new cannot produce new text. Waiting for
          // the generic threshold (default 3) would burn another step in
          // both cases.
          const emit =
            sig.detector === "test_repeat"
              ? loopTracker.shouldEmitWarning(
                  sig.warningKey,
                  sig.count,
                  TEST_REPEAT_WARNING_THRESHOLD,
                )
              : sig.detector === "read_repeat"
                ? loopTracker.shouldEmitWarning(
                    sig.warningKey,
                    sig.count,
                    READ_REPEAT_WARNING_THRESHOLD,
                  )
                : sig.detector === "outcome_repeat"
                  ? loopTracker.shouldEmitWarning(
                      sig.warningKey,
                      sig.count,
                      OUTCOME_REPEAT_WARNING_THRESHOLD,
                    )
                  : loopTracker.shouldEmitWarning(sig.warningKey, sig.count);
          if (!emit) {
            continue;
          }
          turn.pendingNotice =
            sig.detector === "wandering"
              ? formatWanderingRedirect(sig.tool, sig.count)
              : sig.detector === "test_repeat"
                ? formatTestRepeatNotice(sig)
                : sig.detector === "read_repeat" && sig.read !== undefined
                  ? formatReadRepeatNotice({ count: sig.count, ...sig.read })
                  : sig.detector === "outcome_repeat"
                    ? formatOutcomeRepeatNotice(sig)
                    : formatRepeatNotice(sig);
          this.deps.onEvent?.({
            type: "loop_detected",
            tool: sig.tool,
            count: sig.count,
            stepIndex: i,
            level: "warn",
            detector: sig.detector,
            ...(sig.read !== undefined
              ? {
                  read: {
                    path: sig.read.path,
                    startLine: sig.read.startLine,
                    endLine: sig.read.endLine,
                    previousFingerprint: sig.read.previousFingerprint,
                    fingerprint: sig.read.fingerprint,
                  },
                }
              : {}),
          });
          this.deps.logger?.warn("no-progress loop detected", {
            sessionId: state.id,
            stepIndex: i,
            tool: sig.tool,
            count: sig.count,
            detector: sig.detector,
            // Path, range and fingerprints only — enough to reconstruct
            // WHY the detector fired without putting a line of the file
            // into the log.
            ...(sig.read !== undefined
              ? {
                  path: sig.read.path,
                  range: `${sig.read.startLine}-${sig.read.endLine}`,
                  fingerprint: sig.read.fingerprint,
                  previousFingerprint: sig.read.previousFingerprint,
                }
              : {}),
          });
        }
        state = await refreshMemoryContext(this.deps, state, options);
        recordSurfacedLessons(state);
        recordSurfacedProcedures(state);
        recordSurfacedNotes(state);
      } catch (err) {
        // A refused inference has executed no tools. Spend at most one compaction
        // retry, before recovery emits a terminal failure or touches step counters.
        const sizeRejection = contextCompactionRejection(err);
        if (sizeRejection !== null &&
            !requestDeadline.signal.aborted && !overflowCompactionAttempted &&
            this.deps.compaction && compactionInput) {
          overflowCompactionAttempted = true;
          const observed = readContextLengthFromRejection(sizeRejection);
          if (observed) this.deps.onContextWindowObserved?.(observed);
          const before = state.compaction;
          state = await (this.deps.compaction.beforeStep({ ...compactionInput, session: state,
            ...(observed ? { contextWindow: observed, profileWindowApplies: false } : {}),
          }, {
            signal: requestDeadline.signal, requested: "overflow",
            ...(options.providerId ? { providerId: options.providerId } : {}),
            ...(options.ephemeral ? { ephemeral: true } : {}),
          }) ?? Promise.resolve(state));
          if (state.compaction !== before) {
            requestDeadline.dispose();
            turn.sizeRepackRetry = { stepIndex: i };
            turn.pendingNotice = noticeForThisStep;
            i -= 1;
            continue;
          }
        }
        const decision = recoverTurnStep(err, {
          state, options, stepIndex: i, finalizationStep, noticeForThisStep,
          effectiveTransport, requestDeadline, resumesStoppedTask, taskStartedAt,
          durationCeilingMs, providerWaitCfg, recoveryStepAvailable,
        }, this.deps, turn);
        if (decision.kind === "wait") {
          const nextRetryMs = decision.nextRetryMs;
          await abortableSleep(nextRetryMs, options.signal);
          turn.outageWaitedMs += nextRetryMs;
          // The retried step still owes the model the notice this
          // attempt carried.
          turn.pendingNotice = noticeForThisStep;
          if (options.signal.aborted) {
            // Stopped while parked. The close below the loop does the
            // rest — status, `loop_completed`, the turn count — exactly
            // once; doing it here as well closed the turn twice: two
            // `loop_completed` events and a turn counted double.
            turn.reason = "cancelled";
            break;
          }
          // Retry the very same step index: `i += 1` runs on `continue`,
          // so step back one to land on it again.
          i -= 1;
          continue;
        }
        if (decision.kind === "retry_same") { i -= 1; continue; }
        if (decision.kind === "retry_next") continue;
        if (decision.kind === "stop") break;
        return finalizeFailedAgentTurn({
          state, options, cancelled: decision.cancelled, category: decision.category,
          runError: decision.runError, creditRefused: decision.creditRefused,
          stepsTaken: turn.stepsTaken, turnIndex, turnStartedAt, surfacedLessonIds,
        }, this.deps, (sessionId) => this.flushSteering(sessionId));

      }
    }

    return finalizeAgentTurn({
      state, options, reason: turn.reason, stepsTaken: turn.stepsTaken, turnIndex, turnStartedAt,
      taskStartedAt, stepCeiling, stopCause: turn.stopCause, creditStop: turn.creditStop, endedOnFinalizationStep: turn.endedOnFinalizationStep,
      surfacedLessonIds, surfacedProcedureIds, surfacedNoteIds,
    }, this.deps, (sessionId) => this.flushSteering(sessionId));

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
