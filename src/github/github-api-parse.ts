/**
 * Narrowing helpers for `GithubApi`: GitHub's JSON → the small typed
 * records the tools show. Kept apart from the client so each file
 * reads as one thing — the transport there, the shapes here.
 */

import { GithubApiError } from "./github-api-types.js";
import type { GithubIssue, GithubPullRequest } from "./github-api-types.js";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * GitHub's error bodies carry a `message` and, for validation
 * failures, an `errors[]` list whose entries say which field was wrong
 * ("A pull request already exists for …", "No commits between …").
 * Those are the lines worth showing; the raw JSON is not.
 */
export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = asRecord(await res.json());
    const parts: string[] = [];
    if (typeof body?.message === "string") parts.push(body.message);
    if (Array.isArray(body?.errors)) {
      for (const e of body.errors) {
        const rec = asRecord(e);
        if (typeof rec?.message === "string") parts.push(rec.message);
        else if (typeof e === "string") parts.push(e);
      }
    }
    return parts.join(" — ").slice(0, 400);
  } catch {
    return "";
  }
}

export function parsePullRequest(raw: unknown): GithubPullRequest {
  const rec = asRecord(raw);
  const number = rec?.number;
  const title = rec?.title;
  if (typeof number !== "number" || typeof title !== "string") {
    throw new GithubApiError("GitHub returned a malformed pull request.", 0);
  }
  const head = asRecord(rec?.head);
  const base = asRecord(rec?.base);
  const user = asRecord(rec?.user);
  return {
    number,
    title,
    state: typeof rec?.state === "string" ? rec.state : "unknown",
    draft: rec?.draft === true,
    head: typeof head?.ref === "string" ? head.ref : "",
    base: typeof base?.ref === "string" ? base.ref : "",
    htmlUrl: typeof rec?.html_url === "string" ? rec.html_url : "",
    author: typeof user?.login === "string" ? user.login : "",
    createdAt: typeof rec?.created_at === "string" ? rec.created_at : "",
  };
}

export function parseIssue(raw: unknown): GithubIssue {
  const rec = asRecord(raw);
  const number = rec?.number;
  const title = rec?.title;
  if (typeof number !== "number" || typeof title !== "string") {
    throw new GithubApiError("GitHub returned a malformed issue.", 0);
  }
  const user = asRecord(rec?.user);
  const labels = Array.isArray(rec?.labels)
    ? rec.labels
        .map((l) => {
          const lr = asRecord(l);
          return typeof lr?.name === "string" ? lr.name : null;
        })
        .filter((l): l is string => l !== null)
    : [];
  return {
    number,
    title,
    state: typeof rec?.state === "string" ? rec.state : "unknown",
    htmlUrl: typeof rec?.html_url === "string" ? rec.html_url : "",
    author: typeof user?.login === "string" ? user.login : "",
    labels,
    createdAt: typeof rec?.created_at === "string" ? rec.created_at : "",
    isPullRequest: rec?.pull_request !== undefined,
  };
}
