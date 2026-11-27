/**
 * The rules an autofix push must pass (ATO-2331), as pure functions.
 *
 * Autofix is opt-in per pull request and bounded: it starts off, an
 * explicit enable turns it on for one PR, and after `maxAttempts`
 * pushes it pauses and waits for a person. A push may only go to the
 * PR's own head branch in the same repository, never to the repo's
 * default branch or the PR's base, and never forced. Precedent: Qwen
 * Code's `/autofix-pr` (Apache-2.0) guarded push, which refuses any
 * target but the PR head and stops after a fixed number of rounds.
 */

import type { PullRequestHead } from "./github-checks.js";
import type { AutofixWatch } from "./pr-autofix-watch-state.js";

export const DEFAULT_AUTOFIX_MAX_ATTEMPTS = 3;
/** Upper bound an operator may set; a runaway loop is the failure this prevents. */
export const AUTOFIX_MAX_ATTEMPTS_CEILING = 10;

export interface AutofixState {
  enabled: boolean;
  maxAttempts: number;
  /** Autofix pushes since enable, or since a person last moved the head. */
  attempts: number;
  paused: boolean;
  /** The PR head branch autofix was enabled for. */
  headRef: string;
  /** SHA autofix last pushed; a third remote head means a person pushed. */
  lastPushedSha: string | null;
  /**
   * The PR head GitHub reported just before that push. GitHub can still
   * report it for a while after the push lands; that is not a move.
   */
  prevHeadSha: string | null;
  updatedAt: string;
  /** The background watcher (ATO-2516); absent = not watched. See `pr-autofix-watch-state.ts`. */
  watch?: AutofixWatch;
}

export function clampMaxAttempts(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_AUTOFIX_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(AUTOFIX_MAX_ATTEMPTS_CEILING, Math.floor(raw)));
}

/** A fresh opt-in: counter at zero, not paused. Re-enabling is how a person resumes. */
export function enableAutofix(
  headRef: string,
  maxAttempts: unknown,
  now: Date,
): AutofixState {
  return {
    enabled: true,
    maxAttempts: clampMaxAttempts(maxAttempts),
    attempts: 0,
    paused: false,
    headRef,
    lastPushedSha: null,
    prevHeadSha: null,
    updatedAt: now.toISOString(),
  };
}

export type AttemptDecision =
  | { ok: true; state: AutofixState; resetByHumanPush: boolean }
  | { ok: false; reason: string; state: AutofixState };

/**
 * May one more autofix push happen now? `remoteHeadSha` is the PR's
 * head as GitHub reports it. If it is neither the SHA autofix last
 * pushed nor the head seen just before that push (GitHub lagging behind
 * our own push), a person pushed in between: the counter restarts and a
 * pause lifts, because the cap is "attempts per PR head", not per PR
 * lifetime.
 */
export function decideAttempt(
  state: AutofixState | undefined,
  remoteHeadSha: string,
  now: Date,
): AttemptDecision {
  if (!state || !state.enabled) {
    const off: AutofixState = state ?? {
      enabled: false,
      maxAttempts: DEFAULT_AUTOFIX_MAX_ATTEMPTS,
      attempts: 0,
      paused: false,
      headRef: "",
      lastPushedSha: null,
      prevHeadSha: null,
      updatedAt: now.toISOString(),
    };
    return {
      ok: false,
      reason:
        "autofix is off for this pull request. It is opt-in: ask the user, then call github.pr.autofix with action \"enable\".",
      state: off,
    };
  }
  const humanMoved =
    state.lastPushedSha !== null &&
    remoteHeadSha !== state.lastPushedSha &&
    remoteHeadSha !== state.prevHeadSha;
  const current: AutofixState = humanMoved
    ? { ...state, attempts: 0, paused: false, lastPushedSha: null, prevHeadSha: null }
    : state;
  if (current.paused || current.attempts >= current.maxAttempts) {
    return {
      ok: false,
      reason: `autofix is paused after ${current.attempts} of ${current.maxAttempts} attempts on this head. Report the remaining failure to the user; a new push by a person, or enabling again, resumes it.`,
      state: { ...current, paused: true, updatedAt: now.toISOString() },
    };
  }
  return { ok: true, state: current, resetByHumanPush: humanMoved };
}

/**
 * Count a push that went through; pause when the cap is reached.
 * `prevHeadSha` is the PR head GitHub reported before this push.
 */
export function recordAutofixPush(
  state: AutofixState,
  pushedSha: string,
  prevHeadSha: string,
  now: Date,
): AutofixState {
  const attempts = state.attempts + 1;
  return {
    ...state,
    attempts,
    paused: attempts >= state.maxAttempts,
    lastPushedSha: pushedSha,
    prevHeadSha,
    updatedAt: now.toISOString(),
  };
}

export interface PushTargetInput {
  pr: PullRequestHead;
  /** `owner/name` of the repository the PR is in. */
  repoSlug: string;
  defaultBranch: string;
  /** The branch autofix was enabled for; the PR must still point at it. */
  enabledHeadRef: string;
}

/** Branch names a fix is never pushed to, whatever the PR says. */
const PROTECTED_NAMES = new Set(["main", "master", "trunk", "develop"]);

/**
 * Where may this autofix push go? Only to the open PR's own head
 * branch, in the same repository (a fork's branch is the contributor's,
 * not ours to write), and never to the default branch or the PR's base.
 */
export function checkAutofixPushTarget(
  input: PushTargetInput,
): { ok: true; target: string } | { ok: false; reason: string } {
  const { pr } = input;
  const head = pr.headRef;
  if (pr.state !== "open") {
    return { ok: false, reason: `pull request #${pr.number} is ${pr.state}, not open` };
  }
  if (head.length === 0) {
    return { ok: false, reason: "the pull request has no head branch" };
  }
  if (pr.headRepo.toLowerCase() !== input.repoSlug.toLowerCase()) {
    return {
      ok: false,
      reason: `the head branch lives in ${pr.headRepo || "a deleted fork"}, not ${input.repoSlug}; autofix only pushes to branches in the PR's own repository`,
    };
  }
  if (head === input.defaultBranch || PROTECTED_NAMES.has(head)) {
    return {
      ok: false,
      reason: `refusing to push to ${head}: it is the default or a protected branch`,
    };
  }
  if (head === pr.baseRef) {
    return { ok: false, reason: `refusing to push to ${head}: it is the PR's base branch` };
  }
  if (input.enabledHeadRef !== head) {
    return {
      ok: false,
      reason: `autofix was enabled for branch ${input.enabledHeadRef}, but the PR now points at ${head}; enable it again`,
    };
  }
  return { ok: true, target: head };
}
