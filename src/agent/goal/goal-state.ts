import { randomUUID } from "node:crypto";

import {
  GOAL_DEFAULT_MAX_ROUNDS,
  GOAL_DEFAULT_MAX_TOKENS,
  GOAL_MAX_CHECKS,
  GOAL_MAX_CRITERIA,
  GOAL_MAX_ROUNDS_CAP,
  type GoalCriterionMark,
  type GoalCriterionState,
  type GoalSpec,
  type GoalState,
  type GoalStatus,
} from "./goal-types.js";

/**
 * Where the goal lives on the session. Reserved metadata, written by the
 * runtime and the TUI's `/goal`; it is saved with the session, so a goal
 * survives a restart.
 */
export const GOAL_METADATA_KEY = "goal";

const STATUSES: readonly GoalStatus[] = [
  "active", "paused", "blocked", "complete", "budget_limited",
];
const MARKS: readonly GoalCriterionMark[] = ["pending", "met", "not_met", "blocked"];

/**
 * This agent process, stamped on a goal whenever it becomes `active`
 * (ATO-1038). A stored `active` goal with another stamp was running in a
 * process that is gone, so it waits for an explicit resume.
 */
const PROCESS_OWNER = randomUUID();

/** The stamp this process puts on the goals it makes active. */
export function goalProcessOwner(): string {
  return PROCESS_OWNER;
}

/**
 * Whether a stored goal says `active` but no run of this process owns it:
 * the agent restarted or crashed mid-goal. Such a goal must not start
 * rounds on the next ordinary message; `/goal resume` continues it.
 */
export function isInterruptedGoal(state: GoalState): boolean {
  return state.status === "active" && state.owner !== PROCESS_OWNER;
}

/**
 * Clean a spec: trimmed, non-empty, de-duplicated, bounded. Throws when
 * no criterion is left, because a goal with nothing to judge would run
 * until its round limit doing nothing useful.
 */
export function normalizeGoalSpec(spec: GoalSpec): Required<GoalSpec> {
  const criteria = uniqueTrimmed(spec.criteria).slice(0, GOAL_MAX_CRITERIA);
  if (criteria.length === 0) throw new Error("a goal needs at least one criterion");
  const checks = uniqueTrimmed(spec.checks ?? []).slice(0, GOAL_MAX_CHECKS);
  return {
    criteria,
    checks,
    maxRounds: clampRounds(spec.maxRounds),
    maxTokens: clampTokens(spec.maxTokens),
  };
}

/** A fresh, active goal from a spec. */
export function createGoalState(spec: GoalSpec, now: number): GoalState {
  const clean = normalizeGoalSpec(spec);
  return {
    version: 1,
    status: "active",
    criteria: clean.criteria.map((text) => ({ text, mark: "pending" })),
    checks: clean.checks,
    maxRounds: clean.maxRounds,
    roundsUsed: 0,
    maxTokens: clean.maxTokens,
    tokensUsed: 0,
    owner: PROCESS_OWNER,
    judgeFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** The spec a stored goal was made from, for passing back into a turn. */
export function goalSpecOf(state: GoalState): GoalSpec {
  return {
    criteria: state.criteria.map((c) => c.text),
    checks: [...state.checks],
    maxRounds: state.maxRounds,
    ...(state.maxTokens > 0 ? { maxTokens: state.maxTokens } : {}),
  };
}

/** Whether a stored goal answers the same spec (resume) or a new one (restart). */
export function sameGoalSpec(state: GoalState, spec: GoalSpec): boolean {
  const clean = normalizeGoalSpec(spec);
  return (
    sameList(state.criteria.map((c) => c.text), clean.criteria) &&
    sameList(state.checks, clean.checks)
  );
}

/**
 * The stored goal, or `null` when there is none or it does not parse.
 * Hand-edited or older metadata must never crash a session load, so
 * anything malformed reads as "no goal".
 */
export function readGoalState(
  metadata: Record<string, unknown> | undefined,
): GoalState | null {
  const raw = metadata?.[GOAL_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !STATUSES.includes(r.status as GoalStatus)) return null;
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) return null;
  const criteria: GoalCriterionState[] = [];
  for (const c of r.criteria) {
    if (c === null || typeof c !== "object") return null;
    const { text, mark, reason } = c as Record<string, unknown>;
    if (typeof text !== "string" || !MARKS.includes(mark as GoalCriterionMark)) return null;
    criteria.push({
      text,
      mark: mark as GoalCriterionMark,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  const checks = Array.isArray(r.checks)
    ? r.checks.filter((c): c is string => typeof c === "string")
    : [];
  const verdict = r.lastVerdict as GoalState["lastVerdict"] | undefined;
  const verdictOk =
    verdict !== undefined && verdict !== null && typeof verdict === "object" &&
    typeof verdict.summary === "string" && Array.isArray(verdict.checks);
  return {
    version: 1,
    status: r.status as GoalStatus,
    criteria,
    checks,
    maxRounds: clampRounds(numberOr(r.maxRounds, GOAL_DEFAULT_MAX_ROUNDS)),
    roundsUsed: Math.max(0, numberOr(r.roundsUsed, 0)),
    // Goals saved before the token budget read as uncapped, nothing used.
    maxTokens: clampTokens(numberOr(r.maxTokens, GOAL_DEFAULT_MAX_TOKENS)),
    tokensUsed: Math.max(0, numberOr(r.tokensUsed, 0)),
    ...(typeof r.owner === "string" ? { owner: r.owner } : {}),
    judgeFailures: Math.max(0, numberOr(r.judgeFailures, 0)),
    ...(typeof r.statusReason === "string" ? { statusReason: r.statusReason } : {}),
    ...(verdictOk ? { lastVerdict: verdict } : {}),
    createdAt: numberOr(r.createdAt, 0),
    updatedAt: numberOr(r.updatedAt, 0),
  };
}

/** Metadata with the goal set, or removed when `state` is `null`. */
export function withGoalState(
  metadata: Record<string, unknown>,
  state: GoalState | null,
): Record<string, unknown> {
  const next = { ...metadata };
  if (state === null) delete next[GOAL_METADATA_KEY];
  else next[GOAL_METADATA_KEY] = state;
  return next;
}

/** Move a goal to a status, stamping why. */
export function setGoalStatus(
  state: GoalState,
  status: GoalStatus,
  now: number,
  reason?: string,
): GoalState {
  const next: GoalState = { ...state, status, updatedAt: now };
  // Going active claims the goal for this process (ATO-1038).
  if (status === "active") next.owner = PROCESS_OWNER;
  if (reason === undefined) delete next.statusReason;
  else next.statusReason = reason;
  return next;
}

/**
 * Make a stopped goal active again. The person chose to go on, so a
 * used-up round or token budget and the judge's failure count start
 * over; marks and the last verdict are kept. "Used up" is any goal with
 * nothing left, not only one stopped for it: a goal paused or blocked on
 * its last round, or left active at its limit by a crash, would otherwise
 * stop again before running a single round. Also the explicit "go on"
 * for a goal a restart cut off (ATO-1038): it claims it for this process.
 */
export function resumeGoalState(state: GoalState, now: number): GoalState {
  const limited = state.status === "budget_limited";
  const roundsUsedUp = limited || state.roundsUsed >= state.maxRounds;
  const tokensUsedUp = limited || tokensExhausted(state);
  return {
    ...setGoalStatus(state, "active", now),
    roundsUsed: roundsUsedUp ? 0 : state.roundsUsed,
    tokensUsed: tokensUsedUp ? 0 : state.tokensUsed,
    judgeFailures: 0,
  };
}

/** Whether a capped goal has spent its token budget. */
export function tokensExhausted(state: GoalState): boolean {
  return state.maxTokens > 0 && state.tokensUsed >= state.maxTokens;
}

/** Criteria the judge marked `met`. */
export function metCount(state: GoalState): number {
  return state.criteria.filter((c) => c.mark === "met").length;
}

/**
 * The compact line under the chat: `Goal: 3/5 criteria green · round 2/10`,
 * with the status appended when the goal is not running.
 */
export function goalSummaryLine(state: GoalState): string {
  const base =
    `Goal: ${metCount(state)}/${state.criteria.length} criteria green` +
    ` · round ${state.roundsUsed}/${state.maxRounds}` +
    (state.maxTokens > 0 ? ` · tokens ${formatTokens(state.tokensUsed)}/${formatTokens(state.maxTokens)}` : "");
  if (isInterruptedGoal(state)) return `${base} · interrupted, /goal resume continues`;
  return state.status === "active" ? base : `${base} · ${statusLabel(state.status)}`;
}

/** The multi-line answer to `/goal status`. */
export function goalStatusReport(state: GoalState): string {
  const lines = [goalSummaryLine(state)];
  if (isInterruptedGoal(state)) {
    lines.push("  interrupted: the agent stopped while this goal was running; /goal resume continues it");
  } else if (state.statusReason) {
    lines.push(`  ${statusLabel(state.status)}: ${state.statusReason}`);
  }
  state.criteria.forEach((c, i) => {
    const reason = c.reason ? ` (${c.reason})` : "";
    lines.push(`  ${i + 1}. [${markLabel(c.mark)}] ${c.text}${reason}`);
  });
  if (state.checks.length === 0) lines.push("  checks: none (add one with /goal check add <cmd>)");
  for (const cmd of state.checks) {
    const last = state.lastVerdict?.checks.find((c) => c.command === cmd);
    const mark = last === undefined ? "not run" : last.passed ? "pass" : "fail";
    lines.push(`  check [${mark}] ${cmd}`);
  }
  if (state.lastVerdict) lines.push(`  last: ${state.lastVerdict.summary}`);
  return lines.join("\n");
}

export function statusLabel(status: GoalStatus): string {
  return status === "budget_limited" ? "budget reached" : status;
}

/** `12.3k`, `1.2M`: short enough for the goal line. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function markLabel(mark: GoalCriterionMark): string {
  return mark === "not_met" ? "not met" : mark;
}

function clampRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return GOAL_DEFAULT_MAX_ROUNDS;
  return Math.min(GOAL_MAX_ROUNDS_CAP, Math.max(1, Math.floor(value)));
}

/** `0` (or anything not a positive number) means no token cap. */
function clampTokens(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function uniqueTrimmed(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (text.length > 0 && !out.includes(text)) out.push(text);
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
