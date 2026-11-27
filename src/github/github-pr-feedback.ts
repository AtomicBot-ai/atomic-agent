/**
 * Review feedback on a pull request, as data (ATO-2516): the review
 * bodies, the inline review comments and the conversation comments a
 * PR autofix round should address.
 *
 * Anyone can comment on a public repository's PR, so a comment is
 * untrusted text written by its author. Only feedback from the repo's
 * own people counts (`author_association` OWNER, MEMBER or
 * COLLABORATOR); comments from anyone else and from bots are counted
 * and left out, never shown. Comments on lines the PR no longer has
 * (GitHub's "outdated", `position: null`) are left out too.
 * Precedent: Claude Code desktop Auto-fix and Copilot autofix act on
 * review comments from the PR's reviewers.
 */

import type { GithubApi } from "./github-api.js";
import { GithubApiError } from "./github-api-types.js";
import { asRecord } from "./github-api-parse.js";
import type { GithubRepoRef } from "./parse-github-remote.js";

export type FeedbackKind = "review" | "inline" | "comment";

export interface FeedbackItem {
  id: number;
  kind: FeedbackKind;
  author: string;
  createdAt: string;
  /** Cut to {@link FEEDBACK_BODY_CHARS}. */
  body: string;
  url: string;
  /** Inline comments only: the file and line the comment sits on. */
  path: string | null;
  line: number | null;
  /** Reviews only: CHANGES_REQUESTED or COMMENTED. */
  reviewState: string | null;
}

/** A parsed entry before the author and age filters. */
export interface RawFeedback extends FeedbackItem {
  association: string;
  isBot: boolean;
  outdated: boolean;
}

export interface PrFeedback {
  /** Oldest first, at most {@link FEEDBACK_MAX_ITEMS} (the newest ones). */
  items: FeedbackItem[];
  leftOut: { outsideTeam: number; bots: number; outdated: number; overCap: number };
  /** `createdAt` of the newest item kept, or null when there is none. */
  newestAt: string | null;
}

export const FEEDBACK_MAX_ITEMS = 20;
export const FEEDBACK_BODY_CHARS = 800;
const TEAM = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function cut(text: string): string {
  const flat = text.trim();
  return flat.length > FEEDBACK_BODY_CHARS ? `${flat.slice(0, FEEDBACK_BODY_CHARS)}...` : flat;
}

function base(rec: Record<string, unknown>, kind: FeedbackKind, createdKey: string): RawFeedback | null {
  const user = asRecord(rec.user);
  const body = typeof rec.body === "string" ? rec.body : "";
  const createdAt = typeof rec[createdKey] === "string" ? (rec[createdKey] as string) : "";
  if (typeof rec.id !== "number" || body.trim().length === 0 || createdAt.length === 0) return null;
  const login = typeof user?.login === "string" ? user.login : "";
  return {
    id: rec.id,
    kind,
    author: login,
    createdAt,
    body: cut(body),
    url: typeof rec.html_url === "string" ? rec.html_url : "",
    path: null,
    line: null,
    reviewState: null,
    association: typeof rec.author_association === "string" ? rec.author_association : "NONE",
    isBot: user?.type === "Bot" || login.endsWith("[bot]"),
    outdated: false,
  };
}

function list(raw: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new GithubApiError(`GitHub returned a malformed ${what} list.`, 0);
  return raw.map(asRecord).filter((r): r is Record<string, unknown> => r !== undefined);
}

/** `GET /pulls/{n}/reviews`: reviews that ask for changes or comment, with a body. */
export function parseReviews(raw: unknown): RawFeedback[] {
  const out: RawFeedback[] = [];
  for (const rec of list(raw, "review")) {
    const state = typeof rec.state === "string" ? rec.state : "";
    if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") continue;
    const item = base(rec, "review", "submitted_at");
    if (item) out.push({ ...item, reviewState: state });
  }
  return out;
}

/** `GET /pulls/{n}/comments`: inline comments; `position: null` means outdated. */
export function parseReviewComments(raw: unknown): RawFeedback[] {
  const out: RawFeedback[] = [];
  for (const rec of list(raw, "review comment")) {
    const item = base(rec, "inline", "created_at");
    if (!item) continue;
    const line = typeof rec.line === "number" ? rec.line : typeof rec.original_line === "number" ? rec.original_line : null;
    out.push({
      ...item,
      path: typeof rec.path === "string" ? rec.path : null,
      line,
      outdated: "position" in rec && rec.position === null,
    });
  }
  return out;
}

/** `GET /issues/{n}/comments`: the PR's conversation tab. */
export function parseIssueComments(raw: unknown): RawFeedback[] {
  return list(raw, "comment")
    .map((rec) => base(rec, "comment", "created_at"))
    .filter((i): i is RawFeedback => i !== null);
}

function publicFields(item: RawFeedback): FeedbackItem {
  return {
    id: item.id,
    kind: item.kind,
    author: item.author,
    createdAt: item.createdAt,
    body: item.body,
    url: item.url,
    path: item.path,
    line: item.line,
    reviewState: item.reviewState,
  };
}

/**
 * Keep what a fix round should address: newer than `since` (strictly),
 * from the repo's team, not a bot, not outdated; the newest
 * {@link FEEDBACK_MAX_ITEMS}, oldest first.
 */
export function selectFeedback(raw: readonly RawFeedback[], since: string | null): PrFeedback {
  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const leftOut = { outsideTeam: 0, bots: 0, outdated: 0, overCap: 0 };
  const kept: FeedbackItem[] = [];
  for (const item of raw) {
    if (!(Date.parse(item.createdAt) > sinceMs)) continue;
    if (item.isBot) leftOut.bots += 1;
    else if (!TEAM.has(item.association)) leftOut.outsideTeam += 1;
    else if (item.outdated) leftOut.outdated += 1;
    else kept.push(publicFields(item));
  }
  kept.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  leftOut.overCap = Math.max(0, kept.length - FEEDBACK_MAX_ITEMS);
  const items = kept.slice(-FEEDBACK_MAX_ITEMS);
  return { items, leftOut, newestAt: items.length > 0 ? items[items.length - 1]!.createdAt : null };
}

function prPath(ref: GithubRepoRef, kind: "pulls" | "issues", number: number): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${kind}/${number}`;
}

/** The three feedback lists of one PR, filtered by {@link selectFeedback}. */
export async function fetchPrFeedback(
  api: GithubApi,
  ref: GithubRepoRef,
  number: number,
  since: string | null,
): Promise<PrFeedback> {
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";
  const [reviews, inline, comments] = await Promise.all([
    api.getJson(`${prPath(ref, "pulls", number)}/reviews?per_page=100`),
    api.getJson(`${prPath(ref, "pulls", number)}/comments?per_page=100&sort=created&direction=desc${sinceQuery}`),
    api.getJson(`${prPath(ref, "issues", number)}/comments?per_page=100${sinceQuery}`),
  ]);
  return selectFeedback(
    [...parseReviews(reviews), ...parseReviewComments(inline), ...parseIssueComments(comments)],
    since,
  );
}
