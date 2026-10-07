import type { AgentLoopDependencies, RunTurnOptions } from "../agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import { recordTurn } from "../../session/session-state.js";
import { userTurn } from "../../session/conversation-turn.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { ToolRole } from "../../tools/tool-roles.js";
import { emptyFusionOrchestratorState } from "../policies/fusion-orchestrator-mode.js";
import { createReviewStallState, type ReviewStallState } from "../review-stall.js";
import { DEFAULT_FUSION_REVIEW_STALL_STEPS } from "../../config/llm-run-mode-config.js";
import { createProgressNoteNoticeState } from "../progress-note-reply.js";
import { ToolLoopTracker } from "../loop-detector.js";
import { getConfig } from "../../config/index.js";

export type TurnPreparationDependencies = Pick<
  AgentLoopDependencies,
  | "onEvent"
  | "resolveLlmSlice"
  | "toolDescriptors"
  | "localBackend"
  | "profileManager"
>;

export function prepareAgentTurn(
  session: SessionState,
  options: RunTurnOptions,
  deps: TurnPreparationDependencies,
) {
  let state = session;
  /**
   * This turn picks up a task an earlier turn stopped at a ceiling or
   * for credit (`continue` after "(paused: …)"): its first request is
   * not the task's first, and a billing refusal pauses it again rather
   * than failing it (item 40).
   */
  const resumesStoppedTask = session.status === "stalled";

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
  // before the runtime tears down SQLite handles. Note that it
  // *signals* — nothing is awaited, so a reflection can still be
  // resuming when the stores close. That is why the decorators and
  // this call site guard their store reads rather than relying on
  // the abort to have finished.

  if (options.userMessage !== undefined) {
    const text = options.userMessage;
    state = recordTurn(state, userTurn(text));
    deps.onEvent?.({ type: "user_message", text });
  }

  const turnIndex = state.turnCount;
  deps.onEvent?.({ type: "turn_started", turnIndex });
  const turnStartedAt = Date.now();

  // A pinned turn is built for the pinned link's wire shape. Resolved
  // once: the pin does not move during a turn, and the global getters
  // below describe the ACTIVE provider, which is the wrong one here.
  const pinnedSlice =
    options.providerId !== undefined && deps.resolveLlmSlice
      ? deps.resolveLlmSlice(options.providerId)
      : null;
  const visibleToolDescriptors = (): readonly ToolDescriptor[] => {
    const filter = options.toolFilter;
    return filter
      ? deps.toolDescriptors.filter(({ name }) => filter(name))
      : deps.toolDescriptors;
  };

  // Proactively sync with the live `llama-server` before the first
  // step. Catches the case where the operator swapped the model
  // between turns — without this, step 0 would still build the prompt
  // with the previous model's template. Skipped whole on a cloud turn
  // (issue #112): there is no llama-server behind the prompt to sync
  // with, and the probe would fail against a backend nobody is using.
  //
  // ...unless the previous turn was actually SERVED by a local link
  // through the fallback chain. `appendLocal` defaults to `true`, so a
  // rate-limited cloud primary falls over to llama-server on every
  // turn while the active provider stays cloud; without this second
  // arm the profile and grammar would stay pinned to whatever the
  // first fallover probed for the whole outage. Take-and-clear, so a
  // recovered primary quiets the probes again after one turn.
  //
  // Run beside the memory recall rather than after it: the two share
  // nothing (recall reads the store and, for a referential follow-up,
  // asks the model to rewrite the query; the sync reads `/props`), and
  // both wait on the same server. In sequence, a server that accepts
  // and never answers cost the turn the rewriter's budget PLUS the
  // probe's before `step_started`; side by side it costs the longer
  // of the two. Neither can throw — the refresh swallows its own
  // failures, keeps the prior profile and is bounded by the client's
  // `PROBE_TIMEOUT_MS`.
  const localLinkServedLastTurn =
    deps.localBackend?.takeLinkServed?.() ?? false;
  const syncProfile = async (): Promise<void> => {
    if (!deps.profileManager) return;
    if ((deps.localBackend?.isActive() ?? true)) {
      if (!(await deps.localBackend?.ensureProbed())) {
        await deps.profileManager.refresh();
      }
    } else if (localLinkServedLastTurn) {
      await deps.profileManager.refresh();
    }
  };
  const profileSynced = syncProfile();
  return {
    state,
    resumesStoppedTask,
    turnIndex,
    turnStartedAt,
    pinnedSlice,
    visibleToolDescriptors,
    profileSynced,
  };
}

export type TurnPolicyDependencies = Pick<
  AgentLoopDependencies,
  "isFusionMode" | "clearFanoutTurnGrant"
>;

export function prepareTurnPolicies(
  sessionId: string,
  options: RunTurnOptions,
  deps: TurnPolicyDependencies,
) {
  // Fusion's division of labour is per TURN, not per session: each
  // turn starts owing a plan and a fan-out before it may write. An
  // ephemeral turn is a worker's own — the gate is the orchestrator's
  // and must never close on the hands it is meant to free.
  const fusionOrchestratorTurn =
    (deps.isFusionMode?.() ?? false) && options.ephemeral !== true;
  let fusionState = emptyFusionOrchestratorState();
  // A review that only reads is made to choose (F41): consecutive
  // read-only steps without a fan-out are counted per turn, the
  // planner is told once at N to delegate or reply, and at 2N the
  // step admits only those exits. `null` off an orchestrator turn.
  // Read from the config per turn, like the task ceilings.
  let reviewStall: ReviewStallState | null = fusionOrchestratorTurn
    ? createReviewStallState(
        getConfig().llm?.runMode?.fusion?.reviewStallSteps ??
          DEFAULT_FUSION_REVIEW_STALL_STEPS,
        options.userMessage,
      )
    : null;
  // A fan-out approval stands for the turn that asked for it and no
  // longer. Cleared here rather than when the turn ends so an aborted
  // or crashed turn cannot leave authority behind for the next one.
  if (fusionOrchestratorTurn) {
    deps.clearFanoutTurnGrant?.(sessionId);
  }
  // The tool role is per turn: a worker's `builder`, the orchestrator's
  // `orchestrator`, everything else `full`. It shapes the stable prefix
  // (per role, so it is stable within the turn), the native wire and
  // the per-request grammar — see `tool-roles.ts`.
  const toolRole: ToolRole =
    options.toolRole ?? (fusionOrchestratorTurn ? "orchestrator" : "full");
  // Claims need evidence, once per turn: a reply that reports a check
  // nothing ran is held back and noticed the first time only
  // (`claim-evidence.ts`); the second is delivered and marked.
  let claimNoticeGiven = false;
  const claimEvidence = {
    noticed: () => claimNoticeGiven,
    markNoticed: () => {
      claimNoticeGiven = true;
    },
  };
  // Links need a source, once per turn, the same way: a reply link no
  // tool result holds is held back the first time only
  // (`link-evidence.ts`).
  let linkNoticeGiven = false;
  const linkEvidence = {
    noticed: () => linkNoticeGiven,
    markNoticed: () => {
      linkNoticeGiven = true;
    },
  };
  // Same shape for the progress-note notice: a `reply` batched with
  // work is kept as a note and the turn goes on; the model is told
  // why once per turn (`progress-note-reply.ts`).
  const progressNotes = createProgressNoteNoticeState();
  return {
    fusionOrchestratorTurn, fusionState, reviewStall, toolRole,
    claimEvidence, linkEvidence, progressNotes,
  };
}

export function prepareTurnBudgets(options: RunTurnOptions) {
  // What the user asked for is a *task*: "register on these ten sites"
  // is one goal made of hundreds of steps. A step count is the wrong
  // thing to end it with, so `maxSteps` is only the length of a leg —
  // the loop checks in at each boundary, says where it is, and keeps
  // going while the work progresses. These are the ceilings that
  // actually stop it.
  const taskCfg = getConfig().agent.task;
  const legSteps = Math.max(1, options.maxSteps);
  const autoContinue = options.autoContinue ?? taskCfg.autoContinue;
  // Without auto-continue the ceiling IS the leg: one leg, then stop,
  // exactly as before this existed.
  const stepCeiling = autoContinue
    ? Math.max(legSteps, options.taskMaxSteps ?? taskCfg.maxSteps)
    : legSteps;
  const durationCeilingMs =
    options.taskMaxDurationMs ?? taskCfg.maxDurationMs;
  const taskStartedAt = Date.now();
  return { legSteps, autoContinue, stepCeiling, durationCeilingMs, taskStartedAt };
}

export function createTurnLoopTracker(): ToolLoopTracker {
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
  return loopTracker;
}
