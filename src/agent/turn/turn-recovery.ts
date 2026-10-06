import type { AgentLoopDependencies, RunTurnOptions } from "../agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import { CancelledError, LlamaServerError, LlmFailure, TransportError, classifyFailure, isRequestSizeRejection } from "../../llm/index.js";
import type { LlmFailureCategory, TruncationDetail } from "../../llm/index.js";
import { readFailingLink } from "../../llm/fallback/failed-attempts.js";
import { describeFailedLinks } from "../../llm/fallback/failed-links.js";
import { readErrnoCode } from "../../llm/errno-code.js";
import { readProviderErrorVerdict } from "../../llm/reliability/provider-error-verdict.js";
import { classifyProviderWaitCause } from "../../llm/reliability/provider-wait-cause.js";
import { composeSizeRejectionNotice, planSizeRejectionRepack } from "./size-rejection-recovery.js";
import { composeTruncationNotice, planTruncationRetry, type TruncationRetry, type TruncationRetryPlan } from "./truncation-recovery.js";
import { PARSE_RECOVERY_BUDGET, composeParseFailureNotice, isRecoverableParseFailure } from "./parse-failure-recovery.js";
import { EMPTY_COMPLETION_RECOVERY_BUDGET, composeEmptyCompletionNotice, isRecoverableEmptyCompletion, repeatedEmptyCompletionError } from "./empty-completion-recovery.js";
import { FINALIZATION_REQUEST_DEADLINE_MS, type RequestDeadline } from "../request-deadline.js";
import { getConfig } from "../../config/index.js";
import type { TurnLoopState } from "./turn-state.js";

export type TurnRecoveryDependencies = Pick<
  AgentLoopDependencies,
  "contextWindow" | "onContextWindowObserved" | "onEvent" | "logger" | "metrics"
>;

export interface TurnRecoveryContext {
  state: SessionState;
  options: RunTurnOptions;
  stepIndex: number;
  finalizationStep: boolean;
  noticeForThisStep: string | undefined;
  effectiveTransport: ToolCallTransport;
  requestDeadline: Pick<RequestDeadline, "dispose" | "fired">;
  resumesStoppedTask: boolean;
  taskStartedAt: number;
  durationCeilingMs: number;
  providerWaitCfg: { enabled: boolean; maxWaitMs: number };
  recoveryStepAvailable: (stepIndex: number) => boolean;
}

export type TurnRecoveryDecision =
  | { kind: "retry_same" }
  | { kind: "retry_next" }
  | { kind: "stop" }
  | { kind: "wait"; nextRetryMs: number }
  | { kind: "failure"; cancelled: boolean; category: LlmFailureCategory; runError: Error; creditRefused: boolean };

export function recoverTurnStep(
  err: unknown,
  context: TurnRecoveryContext,
  deps: TurnRecoveryDependencies,
  turn: TurnLoopState,
): TurnRecoveryDecision {
  const {
    state, options, stepIndex: i, finalizationStep, noticeForThisStep,
    effectiveTransport, requestDeadline, resumesStoppedTask, taskStartedAt,
    durationCeilingMs, providerWaitCfg, recoveryStepAvailable,
  } = context;
  requestDeadline.dispose();
  let runError: Error | null = err instanceof Error ? err : new Error(String(err));
  let category = classifyFailure(err);
  // The task's duration ceiling fired inside the request. It
  // surfaces as an abort — the same shape as Ctrl+C — but it is
  // the task's clock, not the user, so it is read first and never
  // as a cancellation.
  const ceilingFired = requestDeadline.fired() && !options.signal.aborted;
  // `cancelled` is user-initiated and should close the turn
  // cleanly without marking the session as failed. Classified
  // BEFORE the finalization guard below: a user abort during the
  // reserved final step must keep its `cancelled` outcome
  // (issue #107 — cancellation semantics remain unchanged), not
  // be relabelled `max_steps`.
  //
  // Once the turn's own signal has aborted, a request that fails the
  // way requests fail is the stop's doing, not a verdict on the
  // provider. An abort that lands as the stream ends does not always
  // surface as an abort: the socket the stop tore down can come back
  // as `terminated` or `fetch failed`, a cut-off body as a parse or
  // empty-completion failure — read as a transport outage (a wait,
  // then a second close of the turn) or as `failed` with the
  // transport's words, for a turn the user had simply stopped. The
  // `tool` catch-all is left out on purpose: it is what
  // `classifyFailure` answers for an error it does not recognise,
  // which is how a programming error arrives, and that stays a
  // failure — reported as one — whatever the signal says.
  const stoppedRequest = options.signal.aborted && category !== "tool";
  const cancelled =
    !ceilingFired &&
    (stoppedRequest ||
      err instanceof CancelledError ||
      (err instanceof LlmFailure && err.category === "cancelled") ||
      category === "cancelled");
  if (cancelled) category = "cancelled";
  if (ceilingFired) {
    if (!finalizationStep) {
      // Abandon the request and take the reserved summary step
      // now: the next iteration is the finalization step on its
      // own deadline. Nothing ran, so nothing is replayed.
      turn.stopCause = "time_ceiling";
      turn.ceilingFiredMidRequest = true;
      deps.logger?.warn(
        "task time ceiling reached mid-request; running the summary step",
        {
          sessionId: state.id,
          stepIndex: i,
          elapsedMs: Date.now() - taskStartedAt,
          durationCeilingMs,
        },
      );
      runError = null;
      return { kind: "retry_same" };
    }
    // The summary step itself overran its own deadline. A failed
    // finalization must not execute more work — same outcome the
    // finalization guard below preserves.
    deps.logger?.warn(
      "finalization step exceeded its deadline; preserving max-steps outcome",
      {
        sessionId: state.id,
        stepIndex: i,
        deadlineMs: FINALIZATION_REQUEST_DEADLINE_MS,
      },
    );
    turn.stepsTaken += 1;
    turn.reason = "max_steps";
    return { kind: "stop" };
  }
  // The reply was cut short. Retry the step with a request the wall
  // does not apply to — a larger cap, or a prompt packed to the
  // window the server just revealed. Same replay argument as the
  // outage wait below: the completion failed before any tool ran.
  // Ahead of the finalization guard on purpose: the summary step
  // is the one a reasoning model is likeliest to think past, and
  // one bounded retry that replays nothing is not "more work".
  const truncationPlan: TruncationRetryPlan | null = cancelled
    ? null
    : planTruncationRetry({
        error: err,
        alreadyRetried: turn.truncationRetry?.stepIndex === i,
        contextWindow: deps.contextWindow?.() ?? null,
        fallbackMaxTokens: getConfig().localModels.completionMaxTokens,
        canFitWindow: deps.onContextWindowObserved !== undefined,
      });
  if (truncationPlan !== null) {
    const detail: TruncationDetail = truncationPlan.detail;
    const retry: TruncationRetry = truncationPlan.retry;
    turn.truncationRetry = {
      stepIndex: i,
      original: runError,
      ...(retry.kind === "raise_cap"
        ? { maxTokens: retry.maxTokens }
        : {}),
    };
    if (retry.kind === "fit_window") {
      deps.onContextWindowObserved?.(retry.contextWindow);
    }
    // A cut reply is still tokens on the wire, so — like the
    // parse failure below — it breaks any run of empty
    // completions. (A provider outage does not: it produces no
    // completion at all, so the empties on either side of it are
    // still consecutive completions.)
    turn.emptyRecoveries = 0;
    // The notice the cut attempt carried (loop detector, steering,
    // a trimmed batch) is still owed to the retry.
    turn.pendingNotice = composeTruncationNotice(
      noticeForThisStep,
      detail,
      retry,
    );
    deps.onEvent?.({
      type: "completion_truncated",
      stepIndex: i,
      cause: detail.cause,
      completionTokens: detail.completionTokens,
      promptTokens: detail.promptTokens,
      ...(detail.requestedMaxTokens !== undefined
        ? { requestedMaxTokens: detail.requestedMaxTokens }
        : {}),
      retry,
    });
    deps.logger?.warn("completion truncated; retrying the step", {
      sessionId: state.id,
      stepIndex: i,
      cause: detail.cause,
      completionTokens: detail.completionTokens,
      promptTokens: detail.promptTokens,
      // `null` in the log: the request carried no cap at all.
      requestedMaxTokens: detail.requestedMaxTokens ?? null,
      retry: retry.kind,
      ...(retry.kind === "raise_cap"
        ? { maxTokens: retry.maxTokens }
        : { contextWindow: retry.contextWindow }),
    });
    runError = null;
    return { kind: "retry_same" };
  }
  // The retry this turn ANNOUNCED, landing on the finalization
  // step and coming back empty again.
  //
  // The guard below normally swallows a finalization failure: the
  // turn ends `max_steps`/`stalled` and `runError` is dropped.
  // That is right for a step nobody was promised, and wrong here.
  // The operator was told the turn was trying again, and without
  // this recovery the same scenario ends `failed` carrying the
  // model's own diagnosis — so swallowing it would trade a
  // readable failure for "ran out of steps" AND drop the error
  // report, since only `loop_failed` is captured. Reporting it
  // executes no further work, which is the one thing the
  // finalization guard exists to prevent.
  //
  // Both ceilings put the retry here: the step ceiling whenever
  // the empty lands on the second-to-last allowed step (`run
  // --max-steps 2`; a fusion worker at step 38 of its 40), and
  // the duration ceiling whenever `agent.task.maxDurationMs` is
  // crossed between the two attempts.
  const repeatedEmptyAfterAnnouncedRetry =
    turn.emptyRecoveries > 0 && isRecoverableEmptyCompletion(err);
  if (
    finalizationStep &&
    !cancelled &&
    !repeatedEmptyAfterAnnouncedRetry
  ) {
    // A failed finalization must not execute more work or turn a
    // bounded run into an unbounded retry. Preserve the established
    // explicit max-steps/stalled outcome instead.
    deps.logger?.warn(
      "finalization step failed; preserving max-steps outcome",
      {
        sessionId: state.id,
        stepIndex: i,
        error: runError.message,
        category,
      },
    );
    turn.stepsTaken += 1;
    turn.reason = "max_steps";
    return { kind: "stop" };
  }
  // The completion came back but could not be read as tool calls,
  // and the step executor's in-step repair did not rescue it
  // either. Spend an ordinary step on it rather than ending the
  // turn: the next prompt is built fresh at the full completion
  // budget — which the capped repair is not — and carries a
  // `### notice` naming what was rejected, so the model has
  // something to correct against. Same replay argument as the
  // outage park below: a parse failure throws before any tool is
  // dispatched, so nothing is repeated and no side effect is
  // duplicated.
  //
  // The step is counted. It consumed an inference, and leaving
  // `legMadeProgress` false means a leg made entirely of rejected
  // completions still stops at the boundary as `no_progress`.
  //
  // `recoveryStepAvailable` is the leg-boundary half of the
  // finalization guard above: a recovery on the last step of a
  // barren leg would announce a retry the `no_progress` break
  // never performs.
  if (
    !cancelled &&
    turn.parseRecoveries < PARSE_RECOVERY_BUDGET &&
    recoveryStepAvailable(i) &&
    isRecoverableParseFailure(err)
  ) {
    turn.parseRecoveries += 1;
    turn.stepsTaken += 1;
    // The model emitted tokens, just not readable ones — so this
    // breaks any run of empty completions.
    turn.emptyRecoveries = 0;
    // The notice this step was carrying (loop detector, steering,
    // a trimmed batch) is still owed to the next one.
    turn.pendingNotice = composeParseFailureNotice(
      noticeForThisStep,
      runError.message,
    );
    deps.onEvent?.({
      type: "parse_failure_recovered",
      stepIndex: i,
      attempt: turn.parseRecoveries,
      budget: PARSE_RECOVERY_BUDGET,
      reason: runError.message,
    });
    deps.logger?.warn(
      "completion could not be parsed; retrying the turn",
      {
        sessionId: state.id,
        stepIndex: i,
        attempt: turn.parseRecoveries,
        budget: PARSE_RECOVERY_BUDGET,
        error: runError.message,
        category,
      },
    );
    runError = null;
    return { kind: "retry_next" };
  }
  // The completion came back with nothing in it at all — no
  // content, no reasoning, no tool calls — so there was nothing
  // for the parser to read and nothing for the in-step repair to
  // fix. Spend an ordinary step on it for the same reason as the
  // parse failure above: the inference threw before any tool was
  // dispatched, so nothing is repeated, and the next prompt
  // carries a `### notice` telling the model its reply was empty,
  // which is the only correction available for this shape.
  //
  // The step is counted, as the parse recovery is: it consumed an
  // inference, and a leg made of empty completions must still
  // reach its boundary as `no_progress`.
  //
  // And it is only taken when a step is actually left to spend:
  // on the last step of a barren leg the retry would be announced
  // and never performed, and the operator would be handed
  // "ran out of steps" in place of the model's own diagnosis.
  //
  // `!finalizationStep` is redundant today — the guard above only
  // falls through to here for a repeated empty, which has already
  // spent the budget — but it is the invariant that keeps it
  // redundant: a budget above one must never announce a retry on
  // a step the loop is about to leave.
  if (
    !cancelled &&
    !finalizationStep &&
    turn.emptyRecoveries < EMPTY_COMPLETION_RECOVERY_BUDGET &&
    recoveryStepAvailable(i) &&
    isRecoverableEmptyCompletion(err)
  ) {
    turn.emptyRecoveries += 1;
    turn.stepsTaken += 1;
    turn.pendingNotice = composeEmptyCompletionNotice(noticeForThisStep);
    deps.onEvent?.({
      type: "empty_completion_recovered",
      stepIndex: i,
      attempt: turn.emptyRecoveries,
      budget: EMPTY_COMPLETION_RECOVERY_BUDGET,
    });
    deps.logger?.warn("completion was empty; retrying the turn", {
      sessionId: state.id,
      stepIndex: i,
      attempt: turn.emptyRecoveries,
      budget: EMPTY_COMPLETION_RECOVERY_BUDGET,
      category,
    });
    runError = null;
    return { kind: "retry_next" };
  }
  // The budget is spent and the model returned nothing again. The
  // turn is terminal now, but `detectModelFailure`'s message
  // describes a single empty completion — an operator reading it
  // would reasonably conclude the runtime never retried. Say the
  // count instead.
  // `category` is deliberately not recomputed: the rewrite keeps
  // the same `reason` on a `ModelError`, whose category is pinned
  // to `model`, so reclassifying could only ever return what it
  // already holds.
  if (repeatedEmptyAfterAnnouncedRetry) {
    runError = repeatedEmptyCompletionError(err);
  }
  // The provider refused the request for its size. The window it
  // named (or, failing that, most of the prompt just estimated)
  // becomes the learned window, the conversation is packed to it,
  // and the step runs again with a notice. Once per step: a second
  // refusal ends the turn with the provider's own sentence.
  const repack = cancelled
    ? null
    : planSizeRejectionRepack({
        error: err,
        alreadyRetried: turn.sizeRepackRetry?.stepIndex === i,
        raisedCapRefused:
          turn.truncationRetry?.stepIndex === i &&
          turn.truncationRetry.maxTokens !== undefined,
        transport: effectiveTransport,
        promptTokens: turn.lastPromptTokens,
        contextWindow: deps.contextWindow?.() ?? null,
        canFitWindow: deps.onContextWindowObserved !== undefined,
      });
  if (repack !== null) {
    turn.sizeRepackRetry = { stepIndex: i };
    deps.onContextWindowObserved?.(repack.contextWindow);
    turn.pendingNotice = composeSizeRejectionNotice(noticeForThisStep);
    deps.onEvent?.({
      type: "prompt_repacked",
      stepIndex: i,
      contextWindow: repack.contextWindow,
      source: repack.source,
      promptTokens: turn.lastPromptTokens,
    });
    deps.logger?.warn(
      "provider refused the request as too large; repacking to its window and retrying the step",
      {
        sessionId: state.id,
        stepIndex: i,
        contextWindow: repack.contextWindow,
        source: repack.source,
        promptTokens: turn.lastPromptTokens,
        rejection: runError.message,
      },
    );
    runError = null;
    return { kind: "retry_same" };
  }
  // What the provider's error body says, as opposed to its
  // status: exhausted credit is neither an outage to wait out nor
  // a request to fall over — nothing changes until someone tops
  // up. The turn stops where it is, resumable, and the operator
  // is told which provider refused. (A fallback link, when the
  // chain has one, has already been tried by the time the error
  // reaches here.)
  //
  // Paused, that is, once the task has done something to keep: a
  // step of this turn, or an earlier turn's that this one resumes.
  // Refused on the task's very first request, there is nothing to
  // resume: the turn fails at once with the provider's own sentence
  // ("… refused the request: you've run out of funds. Top up …"),
  // the way a refused key does, instead of a "(paused …) after 0
  // steps" reply standing in for an answer (item 40).
  const verdict = cancelled ? null : readProviderErrorVerdict(err);
  const creditRefused = verdict?.kind === "credit_exhausted";
  if (
    verdict?.kind === "credit_exhausted" &&
    (turn.stepsTaken > 0 || resumesStoppedTask)
  ) {
    turn.stopCause = "credit_exhausted";
    turn.creditStop = { provider: verdict.provider, detail: verdict.detail };
    turn.reason = "max_steps";
    deps.onEvent?.({
      type: "credit_exhausted",
      provider: verdict.provider,
      code: verdict.code,
      message: verdict.detail,
    });
    deps.logger?.warn(
      "provider reports exhausted credit; pausing the task",
      {
        sessionId: state.id,
        stepIndex: i,
        provider: verdict.provider,
        code: verdict.code,
        error: verdict.detail,
      },
    );
    runError = null;
    return { kind: "stop" };
  }
  // The provider is not answering. Park the turn instead of
  // killing it: nothing of this step has been committed (a
  // completion failure throws before any tool is dispatched —
  // tool failures come back as results, not throws), so retrying
  // the same index replays nothing and duplicates no side effect.
  // A provider that asked for a cooldown (`retry-after`, "retry in
  // 120 s", OpenRouter's `in_flight_budget_exhausted` — a 402 the
  // outage predicate would otherwise refuse) is waited for as
  // long as it asked, within the same budget.
  //
  // The precondition is "the provider is not answering", not
  // "this step failed": one of our own deadlines expiring is not
  // an observation about the provider at all, and replaying it
  // buys a second helping of the same silence — see
  // `isOwnLlamaDeadlineExpiry`.
  const retryHint = verdict?.kind === "retry_after" ? verdict : null;
  if (
    category === "transport" &&
    !cancelled &&
    !creditRefused &&
    providerWaitCfg.enabled &&
    (isWaitableOutage(err) || retryHint !== null) &&
    turn.outageWaitedMs < providerWaitCfg.maxWaitMs
  ) {
    const nextRetryMs = Math.min(
      retryHint !== null
        ? Math.max(1, retryHint.delayMs)
        : Math.min(
            PROVIDER_WAIT_MAX_BACKOFF_MS,
            PROVIDER_WAIT_BASE_MS * 2 ** turn.outageAttempts,
          ),
      // Never sleep past the budget: the last wait ends exactly at
      // it, so the operator's configured ceiling is the truth.
      Math.max(1, providerWaitCfg.maxWaitMs - turn.outageWaitedMs),
    );
    turn.outageAttempts += 1;
    turn.awaitingRecovery = true;
    const waitedOn = readFailingLink(err);
    const failedBefore = describeFailedLinks(err);
    // The errno behind the outage: `fetch failed` is the same
    // sentence for a local server that is not running and for a
    // network that is down. Read only here, for a `transport`
    // failure (the condition above), so a user's abort, which
    // classifies `cancelled`, never lends its `ABORT_ERR` to it.
    const causeCode = readErrnoCode(err);
    deps.onEvent?.({
      type: "provider_waiting",
      attempt: turn.outageAttempts,
      waitedMs: turn.outageWaitedMs,
      maxWaitMs: providerWaitCfg.maxWaitMs,
      nextRetryMs,
      reason: runError.message,
      cause: classifyProviderWaitCause(err),
      ...(causeCode !== undefined ? { causeCode } : {}),
      ...(waitedOn !== undefined ? { providerId: waitedOn } : {}),
      ...(failedBefore.length > 0
        ? { fallbackFailures: failedBefore }
        : {}),
    });
    deps.logger?.warn("provider unreachable; parking the turn", {
      sessionId: state.id,
      stepIndex: i,
      attempt: turn.outageAttempts,
      waitedMs: turn.outageWaitedMs,
      nextRetryMs,
      error: runError.message,
      ...(causeCode !== undefined ? { causeCode } : {}),
      ...(waitedOn !== undefined ? { providerId: waitedOn } : {}),
    });
    return { kind: "wait", nextRetryMs };
  }
  // A raised cap the provider refused — a 400 naming `max_tokens`
  // or the context length — is not a new failure. The turn fails
  // with the truncation that started it, which names the knob.
  if (
    turn.truncationRetry?.stepIndex === i &&
    turn.truncationRetry.maxTokens !== undefined &&
    isRequestSizeRejection(err)
  ) {
    deps.logger?.warn(
      "provider refused the raised reply cap; failing with the truncation",
      {
        sessionId: state.id,
        stepIndex: i,
        maxTokens: turn.truncationRetry.maxTokens,
        rejection: runError.message,
      },
    );
    runError = turn.truncationRetry.original;
    category = classifyFailure(runError);
  }
  // Same errno as the wait above, for the turn that fails instead
  // of parking (waiting disabled, budget spent, a refusal that
  // will not fix itself). Read off `runError`, which the swap just
  // above may have replaced, and only for `transport`: any other
  // category's code — an abort's `ABORT_ERR` — is not a network
  // cause.
  const failureCauseCode =
    category === "transport" ? readErrnoCode(runError) : undefined;
  deps.logger?.error("agent loop failed", {
    sessionId: state.id,
    stepIndex: i,
    error: runError.message,
    category,
    ...(failureCauseCode !== undefined
      ? { causeCode: failureCauseCode }
      : {}),
  });
  deps.onEvent?.({
    type: "loop_failed",
    error: runError,
    category,
  });
  deps.metrics?.recordLlmFailure({
    sessionId: state.id,
    category,
  });
  return { kind: "failure", cancelled, category, runError, creditRefused };
}

/**
 * Is this failure the kind that fixes itself?
 *
 * `transport` is a broad category — it is also what a wrong
 * `localModels.url` answering 404, a dead API key (401) and a
 * not-installed CLI provider classify as, because all of them mean
 * "this link is unusable, fall over". None of those become usable by
 * waiting, and parking a turn for five minutes in front of a typo is
 * worse than the failure it replaces: the operator gets no message at
 * all until the budget runs out.
 *
 * So the wait is for the failures that plausibly recover on their own —
 * no HTTP response at all (DNS, refused connection, TLS, socket reset),
 * a server error, or the server saying "busy, later" (408 / 429).
 *
 * The one thing `status === null` must NOT sweep up is our own deadline
 * expiring — see {@link isOwnLlamaDeadlineExpiry}.
 */
function isWaitableOutage(err: unknown): boolean {
  // Our own clock ran out. Never evidence about the provider, so it is
  // decided before the status split rather than inside it: the shape
  // arrives as `status === null`, which is otherwise the strongest
  // "no answer at all, wait for it" signal there is.
  if (isOwnLlamaDeadlineExpiry(err)) return false;
  if (!(err instanceof TransportError)) {
    // An untyped socket failure that reached the classifier through
    // `isNetworkError` — no status to inspect, and by construction it is
    // a connection problem rather than a rejection.
    return true;
  }
  if (err.status === null) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

/**
 * Did one of OUR OWN request deadlines fire, rather than the link
 * failing?
 *
 * `LlamaServerClient` already treats this as terminal —
 * `isRetryableLlamaError` refuses to replay a `timedOut` error because
 * "the model is slower than the budget" does not improve on a second
 * attempt. The agent loop was undoing that decision one layer up: every
 * expiry is built with `status === null` (there is no HTTP response to
 * carry a status), so it classified `transport`, satisfied
 * `isWaitableOutage`, and the loop parked and replayed the same step.
 *
 * What that costs, with the shipped defaults — `firstTokenTimeoutMs` is
 * 30 minutes (`ENV_DEFAULTS.FIRST_TOKEN_TIMEOUT_MS`) — on a server that
 * accepts a request and then queues it forever:
 *
 *   t=0      request 1 sent, queues inside llama.cpp, no log line
 *   t=30min  first-token deadline fires → transport → "waitable" → 2 s park
 *   t=30min  request 2 sent, queues, no log line
 *   t=45min  the fusion worker's wall clock aborts the turn
 *            → `max_steps`, `stepCount: 0`, 45.0 minutes, zero tool calls
 *
 * The whole 45-minute budget is spent on two silent attempts, and the
 * operator is handed "ran out of steps" instead of the message the
 * client had already written, which names the deadline and the knob
 * that raises it (issue #490 reports exactly this pair of runs).
 *
 * The timeout KIND is deliberately not inspected, and they do not cost
 * the same, so here is what is actually being traded away:
 *
 *   first-token              30 min   `firstTokenTimeoutMs`
 *   stream-total              6 h     `streamTotalTimeoutMs`
 *   first-token-unreachable  10 min   `SLOTS_UNREACHABLE_BUDGET_MS`
 *   first-token-unresponsive 10 min   `SLOTS_UNREACHABLE_BUDGET_MS`
 *   first-token-stall        300 s    `requestTimeoutMs`
 *   idle                     300 s    `requestTimeoutMs`
 *   total                    300 s    `requestTimeoutMs`
 *
 * Only the first is the 45-minute-worker disaster in #490. Four of the
 * others carry their own positive evidence about the server:
 * `first-token-stall` fires only because `/slots` kept answering right
 * up to the verdict, `stream-total` only because data kept arriving for
 * six hours, and the two ten-minute kinds only after an unbroken run of
 * polls proved the daemon is gone or wedged — for which replaying the
 * step is the one thing that cannot help. `idle` does NOT — it means the socket is still open
 * and nothing has come down it for a whole `requestTimeoutMs`, so what
 * it proves is five minutes stale. A server that actually died mid-turn
 * usually closes the socket instead, which arrives as `ECONNRESET` with
 * `timedOut: false` and is still parked.
 *
 * The three 300 s kinds are narrowed with the other two anyway, because
 * the alternative is worse than the wait it saves: the park does not
 * resume the stream, it replays the whole step from the top, so every
 * token already generated is thrown away and a second full budget is
 * spent reproducing it. `isRetryableLlamaError` made exactly this call
 * one layer down for exactly this reason, and a predicate that reads
 * `timedOut` while that one reads `timedOut` cannot drift apart.
 *
 * Deliberately still waitable, because none of these is our clock:
 *  - `LlamaServerError(timedOut: false)` with an errno — `ECONNREFUSED`
 *    while llama-server restarts, `ECONNRESET`, and the socket-level
 *    `ETIMEDOUT`, which is the kernel's deadline, not ours. `timedOut`
 *    is set only by `createRequestController`'s own three timers, so a
 *    kernel `ETIMEDOUT` never reaches this predicate flagged;
 *  - a bare `TypeError: fetch failed` wrapped as `TransportError(null)`
 *    by `toLlmFailure`, i.e. DNS or TLS failing while a cloud provider
 *    is down;
 *  - `OpenAiHttpError.timedOut`. Its budget is also 300 s, so the cost
 *    argument above would carry over — but a cloud request is not the
 *    thing #490 reports, nothing pins the cloud park's behaviour today,
 *    and one narrowing at a time. Out of scope, not settled.
 *
 * The expiry travels wrapped: `toLlmFailure` rebuilds it as a
 * `TransportError` carrying the original on `cause`, so the outermost
 * error is never the `LlamaServerError` itself. That is one link, not
 * many — `runWithFallback` rethrows the last link's error untouched and
 * keeps the earlier links in a WeakMap beside it (`failed-attempts.ts`)
 * precisely so that predicates like this one cannot be fooled by a
 * previous attempt. The depth cap is therefore slack, not a budget, and
 * exists only so a self-referential or mutually-referential `cause`
 * cannot spin here.
 */
function isOwnLlamaDeadlineExpiry(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof LlamaServerError && current.timedOut) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** First backoff after the provider stops answering. */
const PROVIDER_WAIT_BASE_MS = 2_000;
/**
 * Ceiling on one backoff. An outage lasting minutes should be probed
 * every half-minute, not once an hour — the point is to notice the
 * moment it comes back.
 */
const PROVIDER_WAIT_MAX_BACKOFF_MS = 30_000;



/** Sleep that returns early when the operator aborts the turn. */
export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
