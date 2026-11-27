/**
 * The background PR autofix watch (ATO-2516) as data: what is stored
 * per PR and the pure "is there work this round?" decision.
 *
 * The watcher itself (`pr-autofix-watcher.ts`) reads GitHub on a timer
 * without any model call and files a task only when this decision says
 * there is something to do: a failing CI it has not handed over for
 * this head yet, a merge conflict on a head it has not handed over yet,
 * or review feedback from the repo's team newer than the last round.
 * Precedent: Claude Code desktop Auto-fix (watches a PR's CI,
 * conflicts and review comments and acts only on a change).
 */

import type { ChecksState } from "./github-checks.js";

export type AutofixWatchNotify = "telegram" | "push";

export interface AutofixWatch {
  /** The chat each round runs in, so its report lands there; null = a fresh session. */
  sessionId: string | null;
  /** Where each round's report is also sent; null = the chat only. */
  notify: AutofixWatchNotify | null;
  everyMs: number;
  startedAt: string;
  lastPollAt: string | null;
  /** The head whose failing CI was last handed to a round. */
  ciHandledSha: string | null;
  /** The head whose merge conflict was last handed to a round. */
  conflictHandledSha: string | null;
  /** Feedback created at or before this was handled (or predates the watch). */
  feedbackSeenAt: string;
  /** The last round's task, so a round is never filed while one is still open. */
  taskId: string | null;
}

export const WATCH_DEFAULT_MINUTES = 10;
export const WATCH_MIN_MINUTES = 5;
export const WATCH_MAX_MINUTES = 120;

export function clampWatchMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return WATCH_DEFAULT_MINUTES;
  return Math.max(WATCH_MIN_MINUTES, Math.min(WATCH_MAX_MINUTES, Math.floor(raw)));
}

/**
 * A fresh watch. Feedback already on the PR counts as seen, like the
 * mail trigger's first poll: turning the watch on never replays old
 * comments (the chat that turns it on can handle those right away).
 */
export function startWatch(
  input: { sessionId: string | null; notify: unknown; everyMinutes: unknown },
  now: Date,
): AutofixWatch {
  const notify = input.notify === "telegram" || input.notify === "push" ? input.notify : null;
  return {
    sessionId: input.sessionId,
    notify,
    everyMs: clampWatchMinutes(input.everyMinutes) * 60_000,
    startedAt: now.toISOString(),
    lastPollAt: null,
    ciHandledSha: null,
    conflictHandledSha: null,
    feedbackSeenAt: now.toISOString(),
    taskId: null,
  };
}

export type WatchReason = "ci" | "conflict" | "review";

export interface WatchObservation {
  headSha: string;
  checks: ChecksState;
  conflict: boolean;
  /** `createdAt` of the newest team feedback after `feedbackSeenAt`, or null. */
  newestFeedbackAt: string | null;
}

/**
 * What this round should fix, and the watch as it must be written
 * BEFORE the round's task is filed (so a crash loses at most one round
 * and never files two). No reason: nothing to file, only the poll time
 * moves. A pending or green CI is never a reason.
 */
export function planWatchRound(
  watch: AutofixWatch,
  seen: WatchObservation,
  now: Date,
): { reasons: WatchReason[]; next: AutofixWatch } {
  const reasons: WatchReason[] = [];
  const next: AutofixWatch = { ...watch, lastPollAt: now.toISOString() };
  if (seen.checks === "failure" && watch.ciHandledSha !== seen.headSha) {
    reasons.push("ci");
    next.ciHandledSha = seen.headSha;
  }
  if (seen.conflict && watch.conflictHandledSha !== seen.headSha) {
    reasons.push("conflict");
    next.conflictHandledSha = seen.headSha;
  }
  if (seen.newestFeedbackAt !== null && Date.parse(seen.newestFeedbackAt) > Date.parse(watch.feedbackSeenAt)) {
    reasons.push("review");
    next.feedbackSeenAt = seen.newestFeedbackAt;
  }
  return { reasons, next };
}

/** Is this PR's poll due? */
export function watchDue(watch: AutofixWatch, nowMs: number): boolean {
  if (watch.lastPollAt === null) return true;
  return nowMs - Date.parse(watch.lastPollAt) >= watch.everyMs;
}
