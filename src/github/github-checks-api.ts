/**
 * The read-only requests behind `github.pr.checks` and the autofix
 * guard (ATO-2331): a PR's head, the check runs and commit statuses on
 * that head, and the tail of a failing Actions job's log.
 */

import type { GithubApi } from "./github-api.js";
import { GithubApiError } from "./github-api-types.js";
import { asRecord } from "./github-api-parse.js";
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

/** GitHub's page size cap for both lists. */
const PER_PAGE = 100;
/** Pages read per list: 1 000 checks, far past any real CI matrix. */
export const CHECKS_MAX_PAGES = 10;

/**
 * Every entry of a paged list whose page is an object holding `key`
 * and a `total_count` (check runs, combined status), up to
 * {@link CHECKS_MAX_PAGES} pages (ATO-2516: one page of 100 hid the
 * rest of a big matrix, and a red job past 100 read as green). The
 * first page's shape is returned as is so the parsers keep their
 * malformed-response errors.
 */
async function fetchPaged(api: GithubApi, url: string, key: string): Promise<unknown> {
  const first = await api.getJson(`${url}&page=1`);
  const rec = asRecord(first);
  const entries = rec?.[key];
  if (!Array.isArray(entries)) return first;
  const all: unknown[] = [...entries];
  const total = typeof rec?.total_count === "number" ? rec.total_count : entries.length;
  let page = 1;
  let last = entries.length;
  while (last === PER_PAGE && all.length < total && page < CHECKS_MAX_PAGES) {
    page += 1;
    const next = asRecord(await api.getJson(`${url}&page=${page}`))?.[key];
    if (!Array.isArray(next) || next.length === 0) break;
    all.push(...next);
    last = next.length;
  }
  return { ...rec, [key]: all };
}

/** Check runs plus commit statuses on one commit, folded into one verdict. */
export async function fetchChecks(
  api: GithubApi,
  ref: GithubRepoRef,
  sha: string,
): Promise<ChecksSummary> {
  const commit = `${repoPath(ref)}/commits/${encodeURIComponent(sha)}`;
  const [runs, statuses] = await Promise.all([
    fetchPaged(api, `${commit}/check-runs?per_page=${PER_PAGE}&filter=latest`, "check_runs"),
    fetchPaged(api, `${commit}/status?per_page=${PER_PAGE}`, "statuses"),
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
