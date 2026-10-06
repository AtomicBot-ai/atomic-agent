import type {
  AgentLoopDependencies,
  AgentLoopReason,
  LessonLifecycleOutcome,
  RunTurnOptions,
  RunTurnResult,
  TaskStopCause,
} from "../agent-contract.js";
import type { LlmFailureCategory } from "../../llm/index.js";
import type { SessionState } from "../../session/session-state.js";
import { incrementTurnCount, recordTurn } from "../../session/session-state.js";
import { assistantReplyTurn, isFinalReplyTurn } from "../../session/conversation-turn.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import { formatTurnFailedRecord } from "./parse-failure-recovery.js";
import { MAX_SURFACED_NOTE_ALLOWLIST } from "./turn-memory-context.js";

export type TurnFinalizationDependencies = Pick<
  AgentLoopDependencies,
  "onEvent" | "logger" | "lessonLifecycle" | "reflectionRunner" | "reflectionSegmentation" | "profileFactsProvider"
>;

interface TurnCompletionState {
  state: SessionState;
  options: RunTurnOptions;
  stepsTaken: number;
  turnIndex: number;
  turnStartedAt: number;
  surfacedLessonIds: ReadonlySet<number>;
}

export interface TurnFinalizationContext extends TurnCompletionState {
  reason: AgentLoopReason;
  taskStartedAt: number;
  stepCeiling: number;
  stopCause: TaskStopCause;
  creditStop: { provider: string; detail: string } | null;
  endedOnFinalizationStep: boolean;
  surfacedProcedureIds: ReadonlySet<number>;
  surfacedNoteIds: ReadonlySet<number>;
}

export interface FailedTurnFinalizationContext extends TurnCompletionState {
  cancelled: boolean;
  category: LlmFailureCategory;
  runError: Error;
  creditRefused: boolean;
}

export function formatTaskStoppedReply(input: {
  cause: TaskStopCause;
  stepsTaken: number;
  stepCeiling: number;
  elapsedMs: number;
  /** For `credit_exhausted`: who said so, and what they said. */
  credit?: { provider: string; detail: string };
}): string {
  const minutes = Math.max(1, Math.round(input.elapsedMs / 60_000));
  const spent = `${input.stepsTaken} steps over ~${minutes} min`;
  if (input.cause === "credit_exhausted") {
    const who = input.credit?.provider ?? "the provider";
    const said =
      input.credit?.detail !== undefined && input.credit.detail.length > 0
        ? ` (${input.credit.detail})`
        : "";
    return (
      `(paused: "${who}" reports the account is out of credit${said}, after ${spent}.) ` +
      "Here is where I got to — the work so far is kept in this session. Top up the account, then say `continue` to pick up from here."
    );
  }
  const head =
    input.cause === "time_ceiling"
      ? `(paused: this task hit its time limit after ${spent}.)`
      : input.cause === "no_progress"
        ? `(paused: nothing came back from my last ${spent} of tool calls — something in the environment is failing.)`
        : `(paused: this task hit its step ceiling of ${input.stepCeiling} after ${spent}.)`;
  const tail =
    input.cause === "no_progress"
      ? "Here is where I got to. Check the failing tool or connection, then say `continue`."
      : "Here is where I got to — the work so far is kept in this session. Say `continue` to pick up from here, or raise `agent.task.maxSteps` for longer runs.";
  return `${head} ${tail}`;
}

export function finalizeAgentTurn(
  context: TurnFinalizationContext,
  deps: TurnFinalizationDependencies,
  flushSteering: (sessionId: string) => readonly string[],
): RunTurnResult {
  let { state } = context;
  const {
    options, reason, stepsTaken, turnIndex, turnStartedAt, taskStartedAt,
    stepCeiling, stopCause, creditStop, endedOnFinalizationStep,
    surfacedLessonIds, surfacedProcedureIds, surfacedNoteIds,
  } = context;
  if (reason === "cancelled") {
    state = { ...state, status: "cancelled" };
    deps.onEvent?.({ type: "loop_completed", reason });
  } else if (reason === "max_steps") {
    const synthetic = formatTaskStoppedReply({
      cause: stopCause,
      stepsTaken,
      stepCeiling,
      elapsedMs: Date.now() - taskStartedAt,
      ...(creditStop !== null ? { credit: creditStop } : {}),
    });
    state = recordTurn(state, assistantReplyTurn(synthetic));
    deps.onEvent?.({
      type: "llm_event",
      event: { type: "assistant_reply", text: synthetic },
    });
    deps.onEvent?.({ type: "loop_completed", reason });
    if (state.status !== "completed") {
      // `stalled` (not `pending`) signals to operators that the turn
      // hit the step budget without a natural close. `lastError`
      // carries the machine-readable reason plus the observed step
      // count so post-mortem tooling does not need to replay events.
      state = {
        ...state,
        status: "stalled",
        lastError:
          creditStop !== null
            ? `task_stopped:${stopCause}: "${creditStop.provider}" is out of credit after ${stepsTaken} steps`
            : `task_stopped:${stopCause}: ${stepsTaken} steps without reply`,
      };
    }
  } else if (reason === "reply") {
    state = { ...state, status: "pending" };
    deps.onEvent?.({ type: "loop_completed", reason });
  } else if (reason === "finish") {
    deps.logger?.info("agent loop finished via finish tool", {
      sessionId: state.id,
    });
    deps.onEvent?.({ type: "loop_completed", reason });
  }

  state = incrementTurnCount(state);
  const durationMs = Date.now() - turnStartedAt;
  deps.onEvent?.({
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
  if (!options.ephemeral && (reason === "reply" || reason === "finish")) {
    invokeLessonLifecycle(deps, state.id, surfacedLessonIds, "success");
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
  //
  // Never for an ephemeral turn: a fusion worker's transcript is the
  // orchestrator's scratch space, and reflecting on it would write
  // half-context into the operator's long-term memory.
  if (
    deps.reflectionRunner &&
    !options.ephemeral &&
    (reason === "reply" || reason === "finish")
  ) {
    const segmentation = deps.reflectionSegmentation;
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
        // renderer surfaces them whenever they are pinned or pass
        // the contextual-keyword gate. Sourcing them here keeps the
        // decorator's hydration cheap.
        // `profileFactsProvider` is a raw `profileStore.list()`.
        // It is only ever an input to the fire-and-forget reflection
        // below, so a store failure here must not fail the turn the
        // user is waiting on — an empty allowlist just means the
        // vote-runner sees no profile candidates this turn.
        let profileFacts: readonly ProfileFact[] = [];
        try {
          profileFacts = deps.profileFactsProvider?.() ?? [];
        } catch (err) {
          // Usually the step guard above has already warned for this
          // turn — same provider, same store. Not always: the store
          // can close between the last step and this block.
          deps.logger?.warn("profile facts unavailable for reflection", {
            sessionId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // `reflect()` is documented fire-safe, but it is composed at
        // runtime from decorators that read SQLite stores. A bare
        // `void` turns any escape into an unhandled rejection the
        // loop can neither see nor recover from, so the trailing
        // `.catch` pins the contract at the call site too.
        void deps.reflectionRunner
          .reflect({
            sessionId: state.id,
            userMessage,
            assistantReply,
            // Memory-v2 phase 2. Surfaced ids for this turn — the
            // allowlist for the link-generator sub-call, and for the
            // EVOLVE directives inside reflection. Every note
            // surfaced through any step, not just the last refresh's
            // recall. Empty / undefined when memory.notes is
            // disabled OR no recall was performed; capped at the
            // most recently surfaced `MAX_SURFACED_NOTE_ALLOWLIST`
            // so a long turn cannot grow the link-generator prompt
            // without bound.
            ...(surfacedNoteIds.size > 0
              ? {
                  recalledMemoryIds: Array.from(surfacedNoteIds).slice(
                    -MAX_SURFACED_NOTE_ALLOWLIST,
                  ),
                }
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
          })
          .catch((err: unknown) => {
            deps.logger?.warn("reflection failed after dispatch", {
              sessionId: state.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }
  }

  return {
    session: state,
    reason,
    stepCount: stepsTaken,
    ...(reason === "max_steps" || endedOnFinalizationStep
      ? { stopCause }
      : {}),
    undelivered: flushSteering(state.id),
  };
}

export function finalizeFailedAgentTurn(
  context: FailedTurnFinalizationContext,
  deps: TurnFinalizationDependencies,
  flushSteering: (sessionId: string) => readonly string[],
): RunTurnResult {
  let { state } = context;
  const {
    options, cancelled, category, runError, creditRefused,
    stepsTaken, turnIndex, turnStartedAt, surfacedLessonIds,
  } = context;
  if (cancelled) {
    state = { ...state, status: "cancelled" };
    deps.onEvent?.({ type: "loop_completed", reason: "cancelled" });
    state = incrementTurnCount(state);
    const durationMs = Date.now() - turnStartedAt;
    deps.onEvent?.({
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
      undelivered: flushSteering(state.id),
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
  //
  // Leave the failure in the transcript. Without it the next turn
  // — usually the operator typing "try again" — is built from a
  // history in which the attempt never happened, and the model
  // reproduces the same rejected output. Recorded only: every
  // surface already renders its own line from `loop_failed`, so
  // emitting an `assistant_reply` event here would post the text
  // twice.
  state = recordTurn(
    state,
    assistantReplyTurn(
      formatTurnFailedRecord(category, runError.message),
    ),
  );
  state = { ...state, status: "failed", lastError: runError.message };
  deps.onEvent?.({ type: "loop_completed", reason: "failed" });
  state = incrementTurnCount(state);
  const durationMs = Date.now() - turnStartedAt;
  deps.onEvent?.({
    type: "turn_finished",
    turnIndex,
    reason: "failed",
    stepCount: stepsTaken,
    durationMs,
  });
  // Phase 6 — bump failure_count for every surfaced lesson.
  // `cancelled` is intentionally NOT routed here; that branch
  // returned earlier without calling the hook (cancellation
  // carries neither success nor failure signal). Nor is an account
  // that cannot pay (item 40): it says nothing about the lessons
  // recalled at turn start, as the paused path for it says nothing.
  if (!options.ephemeral && !creditRefused) {
    invokeLessonLifecycle(
      deps,
      state.id,
      surfacedLessonIds,
      "failure",
    );
  }
  return {
    session: state,
    reason: "failed",
    stepCount: stepsTaken,
    undelivered: flushSteering(state.id),
  };
}


/**
 * Phase 6 — fire the lesson lifecycle hook exactly once with the
 * de-duplicated set of surfaced ids. Empty set or missing hook is a
 * silent no-op. Hook errors are swallowed so a sqlite hiccup never
 * derails the agent-loop return path.
 */
function invokeLessonLifecycle(
  deps: TurnFinalizationDependencies,
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
    if (isFinalReplyTurn(turn)) return turn.text;
  }
  return null;
}

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
      pendingUser =
        pendingUser === null ? turn.text : `${pendingUser}\n\n${turn.text}`;
    } else if (isFinalReplyTurn(turn) && pendingUser !== null) {
      pairs.push({ user: pendingUser, assistant: turn.text });
      pendingUser = null;
    }
  }
  if (pairs.length <= windowTurns) return pairs;
  return pairs.slice(pairs.length - windowTurns);
}
