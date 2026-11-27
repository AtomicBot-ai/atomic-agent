/**
 * The read-only requests behind `github.pr.checks` and the autofix
 * guard (ATO-2331): a PR's head, the check runs and commit statuses on
 * that head, and the tail of a failing Actions job's log.
 */

import type { GithubApi } from "./github-api.js";
import { GithubApiError } from "./github-api-types.js";
import {
  parseCheckRuns,
  parseCommitStatuses,
  parsePullRequestHead,
  summarizeChecks,
  type ChecksSummary,
  type PullRequestHead,
} from "./github-checks.js";
import { extractLogTail, readBodyTail, type LogTail } from "./github-log-tail.js";
import type { GithubRepoRef } from "./parse-github-remote.js";

function repoPath(ref: GithubRepoRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

export async function fetchPullRequestHead(
  api: GithubApi,
  ref: GithubRepoRef,
  number: number,
): Promise<PullRequestHead> {
  return parsePullRequestHead(await api.getJson(`${repoPath(ref)}/pulls/${number}`));
}

/** Check runs plus commit statuses on one commit, folded into one verdict. */
export async function fetchChecks(
  api: GithubApi,
  ref: GithubRepoRef,
  sha: string,
): Promise<ChecksSummary> {
  const commit = `${repoPath(ref)}/commits/${encodeURIComponent(sha)}`;
  const [runs, statuses] = await Promise.all([
    api.getJson(`${commit}/check-runs?per_page=100&filter=latest`),
    api.getJson(`${commit}/status?per_page=100`),
  ]);
  return summarizeChecks([...parseCheckRuns(runs), ...parseCommitStatuses(statuses)]);
}

/**
 * The tail of one Actions job's log, or the reason there is none (logs
 * expire after the repo's retention period; a token without `actions:
 * read` gets 403). Never throws for a missing log: a red check with no
 * readable log is still a red check the model must hear about.
 */
export async function fetchJobLogTail(
  api: GithubApi,
  ref: GithubRepoRef,
  jobId: number,
  maxChars?: number,
): Promise<{ ok: true; tail: LogTail } | { ok: false; reason: string }> {
  try {
    const res = await api.getResponse(`${repoPath(ref)}/actions/jobs/${jobId}/logs`);
    const { text, truncated } = await readBodyTail(res);
    const tail = extractLogTail(text, {
      alreadyTruncated: truncated,
      ...(maxChars === undefined ? {} : { maxChars }),
    });
    return { ok: true, tail };
  } catch (err) {
    if (err instanceof GithubApiError) return { ok: false, reason: err.message };
    throw err;
  }
}
