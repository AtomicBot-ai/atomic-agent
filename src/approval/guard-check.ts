/**
 * What the gate asks of plain-text security rules (ATO-2111): whether a
 * call is covered, and the outcome of reviewing it against every rule
 * set (the person's file, then the project's, each in its own pass so
 * the project file can only add blocks). Never throws: every failure is
 * `failed`, settled by the file's `onFailure`.
 */
import type { ApprovalRequest } from "./approval-gate.js";
import type { GuardFailurePolicy, GuardRules } from "./guard-rules.js";
import { GUARD_REVIEW_TIMEOUT_MS, type GuardReviewFn, type GuardVerdict } from "./guard-review.js";

export type GuardOutcome =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "failed"; onFailure: GuardFailurePolicy };

export interface SecurityGuard {
  /** The rules for a call in `workdir`, or `null` when no guard file exists. */
  rules(workdir: string | undefined): GuardRules | null;
  review: GuardReviewFn;
  timeoutMs?: number;
}

/** The rules that cover `request`, or `null` when the guard does not look at it. */
export function guardRulesFor(
  guard: SecurityGuard,
  request: Pick<ApprovalRequest, "tool">,
  workdir: string | undefined,
): GuardRules | null {
  let rules: GuardRules | null;
  try {
    rules = guard.rules(workdir);
  } catch {
    // A rules source that throws is a broken file, not "no rules".
    return { sets: [{ source: "user", rules: "The rules could not be read. Block every action." }], tools: new Set([request.tool]), onFailure: "block" };
  }
  if (rules === null || rules.sets.length === 0 || !rules.tools.has(request.tool)) return null;
  return rules;
}

async function reviewWithDeadline(
  review: GuardReviewFn,
  request: ApprovalRequest,
  set: GuardRules["sets"][number],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<GuardVerdict | null> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return (await Promise.race([review(request, set, controller.signal), deadline])) ?? null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Review `request` against each rule set in turn; the first block or failure decides. */
export async function runGuard(
  guard: SecurityGuard,
  request: ApprovalRequest,
  rules: GuardRules,
  signal?: AbortSignal,
): Promise<GuardOutcome> {
  for (const set of rules.sets) {
    const verdict = await reviewWithDeadline(
      guard.review,
      request,
      set,
      signal,
      guard.timeoutMs ?? GUARD_REVIEW_TIMEOUT_MS,
    );
    if (verdict === null) return { kind: "failed", onFailure: rules.onFailure };
    if (verdict.decision === "block") return { kind: "block", reason: verdict.reason };
  }
  return { kind: "allow" };
}

/** What the model reads when the rules block a call. */
export function guardBlockReason(reason: string): string {
  return `Blocked by your security rules: ${reason.length > 0 ? reason : "the reviewer named no rule"}`;
}

/** What the model reads when the reviewer failed under `onFailure: block`. */
export const GUARD_FAILURE_BLOCK_REASON =
  "Blocked by your security rules: the rules reviewer gave no answer, and guard.md says onFailure: block";

/** The note a prompt carries when the reviewer failed under `onFailure: ask`. */
export const GUARD_FAILURE_ASK_NOTE = "security rules check: no answer from the reviewer, asking you";
