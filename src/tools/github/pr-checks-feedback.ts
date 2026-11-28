/**
 * The merge-conflict line and the review-feedback section of
 * `github.pr.checks` (ATO-2516). Feedback is text written by its
 * author; only the repo's team is shown (see `github-pr-feedback.ts`),
 * and the whole result is framed as untrusted by the tool.
 */

import {
  GithubApiError,
  fetchPrFeedback,
  hasMergeConflict,
  type FeedbackItem,
  type GithubApi,
  type GithubRepoRef,
  type PrFeedback,
  type PullRequestHead,
} from "../../github/index.js";

/** Characters of review feedback shown in one result, across all items. */
export const PR_CHECKS_FEEDBACK_BUDGET_CHARS = 2_000;

export function mergeLine(pr: Pick<PullRequestHead, "mergeable" | "mergeableState" | "baseRef">): string {
  if (hasMergeConflict(pr)) {
    return `merge: CONFLICT with ${pr.baseRef} (merge the base in with github.pr.autofix "merge-base")`;
  }
  if (pr.mergeable === null) return `merge: GitHub is still checking for conflicts with ${pr.baseRef}`;
  return `merge: no conflict with ${pr.baseRef}`;
}

/** An ISO time, or null; anything else is an error the model can fix. */
export function parseSince(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return new Date(Date.parse(raw)).toISOString();
  throw new Error("github.pr.checks: `since` must be an ISO date and time, such as 2026-11-27T12:00:00Z");
}

/** Feedback, or null when GitHub would not give it: CI is still worth showing. */
export async function readFeedback(
  api: GithubApi,
  ref: GithubRepoRef,
  number: number,
  since: string | null,
): Promise<PrFeedback | { error: string }> {
  try {
    return await fetchPrFeedback(api, ref, number, since);
  } catch (err) {
    if (err instanceof GithubApiError) return { error: err.message };
    throw err;
  }
}

function where(item: FeedbackItem): string {
  if (item.kind === "inline") return `${item.path ?? "?"}${item.line !== null ? `:${item.line}` : ""}`;
  if (item.kind === "review") return `review, ${item.reviewState === "CHANGES_REQUESTED" ? "changes requested" : "comment"}`;
  return "conversation";
}

export function feedbackLines(feedback: PrFeedback | { error: string }, since: string | null): string[] {
  if ("error" in feedback) return [`--- review feedback: not available (${feedback.error})`];
  const scope = since ? ` since ${since}` : "";
  const { leftOut } = feedback;
  const skipped = [
    leftOut.outsideTeam > 0 ? `${leftOut.outsideTeam} from people outside the repo team` : "",
    leftOut.bots > 0 ? `${leftOut.bots} from bots` : "",
    leftOut.outdated > 0 ? `${leftOut.outdated} on outdated lines` : "",
    leftOut.overCap > 0 ? `${leftOut.overCap} older over the limit` : "",
  ].filter(Boolean);
  const out = [`--- review feedback${scope}: ${feedback.items.length} from the repo team${skipped.length ? ` (left out: ${skipped.join(", ")})` : ""}`];
  let budget = PR_CHECKS_FEEDBACK_BUDGET_CHARS;
  for (const item of feedback.items) {
    const head = `[${where(item)}] @${item.author}: `;
    const room = Math.max(0, budget - head.length);
    if (room < 40) {
      out.push(`(${feedback.items.length - out.length + 1} more not shown)`);
      break;
    }
    const body = item.body.replace(/\s+/g, " ");
    out.push(head + (body.length > room ? `${body.slice(0, room)}...` : body));
    budget -= head.length + Math.min(body.length, room);
  }
  return out;
}

export function feedbackDetails(feedback: PrFeedback | { error: string }): Record<string, unknown> {
  if ("error" in feedback) return { available: false };
  return {
    available: true,
    count: feedback.items.length,
    newestAt: feedback.newestAt,
    items: feedback.items.map((i) => ({ id: i.id, kind: i.kind, author: i.author, path: i.path, line: i.line, url: i.url })),
    leftOut: feedback.leftOut,
  };
}

/** Whether a feedback read has anything to show (it then takes part of the log budget). */
export function hasFeedbackItems(feedback: PrFeedback | { error: string } | null): boolean {
  return feedback !== null && !("error" in feedback) && feedback.items.length > 0;
}
