/**
 * Data shapes for goal mode (ATO-451): a turn that keeps going, round
 * after round, until an acceptance list is green, a person is needed,
 * or a limit is reached. Types only; the state helpers live in
 * `goal-state.ts` and the round loop in `goal-controller.ts`.
 */

/**
 * What the caller asks for. `criteria` is the acceptance list, judged by
 * the model after every round. `checks` are shell commands that must
 * exit 0; they run before the judge and a failing one skips it.
 */
export interface GoalSpec {
  criteria: string[];
  checks?: string[];
  /** Work rounds before the goal stops as `budget_limited`. */
  maxRounds?: number;
}

/**
 * Where a goal stands. Only the controller moves a goal to `complete`,
 * `blocked` or `budget_limited`; `paused` is also the operator's (and
 * the controller's when a turn is stopped, fails, or the judge breaks).
 */
export type GoalStatus =
  "active" | "paused" | "blocked" | "complete" | "budget_limited";

/** The judge's answer for one criterion; `pending` before any verdict. */
export type GoalCriterionMark = "pending" | "met" | "not_met" | "blocked";

export interface GoalCriterionState {
  text: string;
  mark: GoalCriterionMark;
  /** The judge's one-line reason for the last mark. */
  reason?: string;
}

/** One shell check after one round. `output` is already trimmed. */
export interface GoalCheckResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** What the last evaluation found, kept for `/goal status` and the next round. */
export interface GoalVerdict {
  at: number;
  round: number;
  /** One line a person can read. */
  summary: string;
  checks: { command: string; passed: boolean }[];
}

/**
 * The goal as stored with the session (`session.metadata.goal`), so a
 * restart picks it up where it stopped. Plain JSON on purpose.
 */
export interface GoalState {
  version: 1;
  status: GoalStatus;
  criteria: GoalCriterionState[];
  checks: string[];
  maxRounds: number;
  roundsUsed: number;
  /** Unreadable or failed judge replies in a row; reset by a readable one. */
  judgeFailures: number;
  /** Why the goal is not `active`, in words for the person. */
  statusReason?: string;
  lastVerdict?: GoalVerdict;
  createdAt: number;
  updatedAt: number;
}

/** Default round limit when the spec names none. */
export const GOAL_DEFAULT_MAX_ROUNDS = 10;
/** Upper bound on `maxRounds`, so a typo cannot ask for a week of work. */
export const GOAL_MAX_ROUNDS_CAP = 50;
/**
 * Unreadable or failed judge replies in a row before the goal pauses.
 * Stricter than Hermes: a broken judge stops the run, it never loops.
 */
export const GOAL_MAX_JUDGE_FAILURES = 3;
/** Wall-clock cap for one shell check. */
export const GOAL_CHECK_TIMEOUT_MS = 300_000;
/** Characters of a failing check's output carried into the next round. */
export const GOAL_CHECK_OUTPUT_MAX_CHARS = 2_000;
/** Bounds on the acceptance list. */
export const GOAL_MAX_CRITERIA = 20;
export const GOAL_MAX_CHECKS = 10;
