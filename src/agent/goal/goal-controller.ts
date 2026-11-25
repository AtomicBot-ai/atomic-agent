import type { RunTurnResult } from "../agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import { previousReplyText } from "../../prompt/request-section.js";
import { parseGoalVerdict, type GoalJudgeInput } from "./goal-judge.js";
import { buildGoalContinuationMessage, trimCheckOutput } from "./goal-messages.js";
import { metCount, setGoalStatus, tokensExhausted, withGoalState } from "./goal-state.js";
import {
  GOAL_MAX_JUDGE_FAILURES,
  type GoalCheckResult,
  type GoalState,
} from "./goal-types.js";

/**
 * The goal controller: wraps ordinary turns into rounds. After a round
 * that ended normally it runs the shell checks, then (if they pass) asks
 * the judge, then either starts the next round with what is still open,
 * or stops. Every way out is bounded: the round limit, the token budget,
 * the turn's time ceiling and money budget, a stopped or failed turn, a
 * blocked item, a broken judge.
 *
 * Dependencies are injected so the loop is testable without a model or a
 * shell; the runtime supplies the real ones (`runtime-goal.ts`).
 */
export interface GoalControllerDeps {
  /** One ordinary turn (`runtime.runTurn` without a goal). */
  runRound(
    session: SessionState,
    message: string,
    options: { taskMaxDurationMs?: number; taskMaxCostUsd?: number },
  ): Promise<RunTurnResult>;
  /** Run the goal's shell checks in the session's folder. */
  runChecks(
    commands: readonly string[],
    context: { workingDir: string; signal: AbortSignal },
  ): Promise<GoalCheckResult[]>;
  /** One judge call; resolves to its raw text, rejects on transport errors. */
  judge(input: GoalJudgeInput, context: { sessionId: string; signal: AbortSignal }): Promise<string>;
  /** Persist the goal with the session after every change. */
  saveGoal(sessionId: string, state: GoalState): void;
  /**
   * The operator's request between rounds (`/goal pause`, `/goal clear`).
   * Read before every round, so a pause lands after the current one.
   */
  pendingControl?(sessionId: string): "pause" | "clear" | null;
  /** Called after every state change, for a live goal line. */
  onProgress?(state: GoalState): void;
  now?(): number;
}

export interface GoalRunInput {
  session: SessionState;
  /** The first round's message (the person's, or the kickoff). */
  message: string;
  goal: GoalState;
  signal: AbortSignal;
  /** Wall-clock budget for all rounds together; absent, rounds alone limit. */
  taskMaxDurationMs?: number;
  /**
   * Money budget for all rounds together, in USD (ATO-1288). Each round
   * gets what the earlier ones left; absent or `0`, no cap.
   */
  taskMaxCostUsd?: number;
}

export interface GoalRunOutcome {
  /** The last round's result (its session carries the final goal too). */
  result: RunTurnResult;
  /** The goal as it stopped; `null` when the operator cleared it. */
  goal: GoalState | null;
}

export async function runGoal(
  deps: GoalControllerDeps,
  input: GoalRunInput,
): Promise<GoalRunOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = input.taskMaxDurationMs === undefined
    ? undefined
    : now() + input.taskMaxDurationMs;
  let goal = setGoalStatus(input.goal, "active", now());
  let session = input.session;
  let message = input.message;
  let last: RunTurnResult | undefined;
  const costCap = input.taskMaxCostUsd !== undefined && Number.isFinite(input.taskMaxCostUsd) && input.taskMaxCostUsd > 0
    ? input.taskMaxCostUsd
    : undefined;
  // What the rounds spent together; `undefined` until one reports spend.
  let spentUsd: number | undefined;
  // Tokens the rounds of this run reported, for the caller's `usage`.
  let usage: RunTurnResult["usage"];

  const commit = (next: GoalState): GoalState => {
    goal = next;
    deps.saveGoal(session.id, goal);
    deps.onProgress?.(goal);
    return goal;
  };
  const stop = (status: GoalState["status"], reason: string): GoalRunOutcome => {
    commit(setGoalStatus(goal, status, now(), reason));
    return finish(last, session, goal, spentUsd, usage);
  };

  for (;;) {
    const control = deps.pendingControl?.(session.id) ?? null;
    if (control === "clear") return finish(last, session, null, spentUsd, usage);
    if (control === "pause") return stop("paused", "paused by you");
    if (input.signal.aborted) return stop("paused", "the turn was stopped");
    if (goal.roundsUsed >= goal.maxRounds) {
      return stop("budget_limited", `used all ${goal.maxRounds} rounds`);
    }
    if (tokensExhausted(goal)) {
      return stop("budget_limited", `used the token budget (${goal.tokensUsed} of ${goal.maxTokens} tokens)`);
    }
    const remaining = deadline === undefined ? undefined : deadline - now();
    if (remaining !== undefined && remaining <= 0) {
      return stop("budget_limited", "the time limit for this run ran out");
    }
    const costLeft = costCap === undefined ? undefined : costCap - (spentUsd ?? 0);
    if (costLeft !== undefined && costLeft <= 0) {
      return stop("budget_limited", "the money budget for this run ran out");
    }

    commit({ ...goal, roundsUsed: goal.roundsUsed + 1, updatedAt: now() });
    last = await deps.runRound(session, message, {
      ...(remaining === undefined ? {} : { taskMaxDurationMs: remaining }),
      ...(costLeft === undefined ? {} : { taskMaxCostUsd: costLeft }),
    });
    session = last.session;
    if (last.spendUsd !== undefined) spentUsd = (spentUsd ?? 0) + last.spendUsd;
    if (last.usage !== undefined) {
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + last.usage.promptTokens,
        completionTokens: (usage?.completionTokens ?? 0) + last.usage.completionTokens,
      };
      // Counted against the goal's token budget (ATO-1036); checked
      // before the next round, so a round in flight is never cut off.
      commit({
        ...goal,
        tokensUsed: goal.tokensUsed + last.usage.promptTokens + last.usage.completionTokens,
        updatedAt: now(),
      });
    }

    const abnormal = abnormalEnding(last);
    if (abnormal) return stop(abnormal.status, abnormal.reason);

    const checks = goal.checks.length === 0
      ? []
      : (await deps.runChecks(goal.checks, { workingDir: session.workingDir, signal: input.signal }))
          .map((c) => ({ ...c, output: trimCheckOutput(c.output) }));
    const failing = checks.filter((c) => !c.passed);
    if (failing.length > 0) {
      commit(withVerdict(goal, now(), `${failing.length} of ${checks.length} checks failing`, checks));
      if (last.reason === "finish") return stop("paused", SESSION_CLOSED);
      message = buildGoalContinuationMessage(goal, failing);
      continue;
    }

    const judged = await judgeRound(deps, goal, {
      criteria: goal.criteria.map((c) => c.text),
      reply: previousReplyText(session.turns) ?? "",
      checks,
    }, { sessionId: session.id, signal: input.signal });
    if (judged.kind === "broken") {
      commit({ ...goal, judgeFailures: judged.failures, updatedAt: now() });
      return stop("paused", `the judge gave no usable verdict ${judged.failures} times in a row (${judged.detail})`);
    }
    const criteria = goal.criteria.map((c, i) => ({
      text: c.text,
      mark: judged.verdict[i]!.mark,
      ...(judged.verdict[i]!.reason ? { reason: judged.verdict[i]!.reason } : {}),
    }));
    goal = { ...goal, criteria, judgeFailures: 0 };
    const blocked = criteria.filter((c) => c.mark === "blocked");
    const summary = `${metCount(goal)}/${criteria.length} criteria met` +
      (blocked.length > 0 ? `, ${blocked.length} blocked` : "");
    commit(withVerdict(goal, now(), summary, checks));
    if (blocked.length > 0) {
      return stop("blocked", blocked.map((c) => `${c.text}: ${c.reason ?? "needs you"}`).join("; "));
    }
    if (criteria.every((c) => c.mark === "met")) {
      return stop("complete", "every item on the acceptance list is met");
    }
    if (last.reason === "finish") return stop("paused", SESSION_CLOSED);
    message = buildGoalContinuationMessage(goal, []);
  }
}

/** `finish` closes the session: no further round can run in it. */
const SESSION_CLOSED = "the agent closed the session before the goal was met";

type JudgeRound =
  | { kind: "ok"; verdict: NonNullable<ReturnType<typeof parseGoalVerdict>> }
  | { kind: "broken"; failures: number; detail: string };

/**
 * Ask the judge, retrying an unreadable or failed answer at once (not in
 * a new work round) until the failure budget, carried across rounds in
 * `judgeFailures`, runs out.
 */
async function judgeRound(
  deps: GoalControllerDeps,
  goal: GoalState,
  input: GoalJudgeInput,
  context: { sessionId: string; signal: AbortSignal },
): Promise<JudgeRound> {
  let failures = goal.judgeFailures;
  let detail = "";
  while (failures < GOAL_MAX_JUDGE_FAILURES) {
    if (context.signal.aborted) break;
    try {
      const text = await deps.judge(input, context);
      const verdict = parseGoalVerdict(text, input.criteria.length);
      if (verdict !== null) return { kind: "ok", verdict };
      detail = "unreadable reply";
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    failures += 1;
  }
  return { kind: "broken", failures, detail: detail || "stopped" };
}

/** A round that did not end with an ordinary answer stops the goal. */
function abnormalEnding(
  result: RunTurnResult,
): { status: GoalState["status"]; reason: string } | null {
  if (result.reason === "cancelled") return { status: "paused", reason: "the turn was stopped" };
  if (result.reason === "failed") return { status: "paused", reason: "the turn failed" };
  const cause: string | undefined = result.stopCause;
  if (cause !== undefined) {
    // Any ceiling (steps, time, and money once budgets land) is a budget.
    return cause.endsWith("_ceiling")
      ? { status: "budget_limited", reason: `the turn hit its ${cause.replace("_", " ")}` }
      : { status: "paused", reason: `the turn stopped (${cause.replace(/_/g, " ")})` };
  }
  if (result.reason === "max_steps") return { status: "budget_limited", reason: "the turn hit its step ceiling" };
  return null;
}

function withVerdict(
  goal: GoalState,
  at: number,
  summary: string,
  checks: readonly GoalCheckResult[],
): GoalState {
  return {
    ...goal,
    updatedAt: at,
    lastVerdict: {
      at,
      round: goal.roundsUsed,
      summary,
      checks: checks.map((c) => ({ command: c.command, passed: c.passed })),
    },
  };
}

function finish(
  last: RunTurnResult | undefined,
  session: SessionState,
  goal: GoalState | null,
  spentUsd: number | undefined,
  usage: RunTurnResult["usage"],
): GoalRunOutcome {
  // Stopped before the first round ran: an empty result on the input session.
  const result: RunTurnResult = last ?? { session, reason: "cancelled", stepCount: 0 };
  // The rounds' sessions carry the goal as it was when each round began;
  // hand back the one that matches what was saved last.
  const finalSession: SessionState = {
    ...result.session,
    metadata: withGoalState(result.session.metadata, goal),
  };
  return {
    // The money of every round, not only the last one: a task's budget
    // and its report read this figure.
    result: {
      ...result,
      session: finalSession,
      ...(goal === null ? {} : { goal }),
      ...(spentUsd === undefined ? {} : { spendUsd: spentUsd }),
      // Likewise the tokens of every round, not only the last one's.
      ...(usage === undefined ? {} : { usage }),
    },
    goal,
  };
}
