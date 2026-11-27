/**
 * CI state of a pull request head, as data (ATO-2331).
 *
 * GitHub reports CI in two parallel systems: check runs (GitHub Actions
 * and most apps) and the older commit statuses (some external CI). A
 * PR is green only when both agree, so both are read and folded into
 * one verdict here. Pure narrowing and folding; the requests live in
 * `github-checks-api.ts`.
 */

import { GithubApiError } from "./github-api-types.js";
import { asRecord } from "./github-api-parse.js";

export type CheckVerdict = "failing" | "pending" | "passing";

export interface CheckItem {
  /** Check run name or commit status context. */
  name: string;
  kind: "check_run" | "status";
  verdict: CheckVerdict;
  /** `conclusion` of a finished run, `status` of a running one, or the status state. */
  detail: string;
  url: string;
  /** The Actions job id (same number as the check run id); null for other apps. */
  actionsJobId: number | null;
}

export type ChecksState = "failure" | "pending" | "success" | "none";

export interface ChecksSummary {
  state: ChecksState;
  failing: CheckItem[];
  pending: CheckItem[];
  passing: CheckItem[];
}

export interface PullRequestHead {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  /** `owner/name` the head branch lives in; differs from the base repo on a fork PR. */
  headRepo: string;
  baseRef: string;
}

/** Conclusions that mean "this check is red". */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

export function parsePullRequestHead(raw: unknown): PullRequestHead {
  const rec = asRecord(raw);
  const head = asRecord(rec?.head);
  const base = asRecord(rec?.base);
  const headRepo = asRecord(head?.repo);
  if (
    typeof rec?.number !== "number" ||
    typeof head?.ref !== "string" ||
    typeof head?.sha !== "string" ||
    typeof base?.ref !== "string"
  ) {
    throw new GithubApiError("GitHub returned a malformed pull request.", 0);
  }
  return {
    number: rec.number,
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "unknown",
    htmlUrl: typeof rec.html_url === "string" ? rec.html_url : "",
    headRef: head.ref,
    headSha: head.sha,
    // A deleted fork has `repo: null`; an empty name never matches the base.
    headRepo: typeof headRepo?.full_name === "string" ? headRepo.full_name : "",
    baseRef: base.ref,
  };
}

/**
 * `GET /commits/{sha}/check-runs` → items. A re-run adds a new check
 * run with the same name, so only the newest run (highest id) per name
 * counts: an old red run must not keep a re-run green PR red.
 */
export function parseCheckRuns(raw: unknown): CheckItem[] {
  const runs = asRecord(raw)?.check_runs;
  if (!Array.isArray(runs)) {
    throw new GithubApiError("GitHub returned a malformed check-run list.", 0);
  }
  const newest = new Map<string, { id: number; item: CheckItem }>();
  for (const entry of runs) {
    const rec = asRecord(entry);
    if (typeof rec?.id !== "number" || typeof rec.name !== "string") continue;
    const status = typeof rec.status === "string" ? rec.status : "queued";
    const conclusion =
      typeof rec.conclusion === "string" ? rec.conclusion : null;
    const verdict: CheckVerdict =
      status !== "completed" || conclusion === null
        ? "pending"
        : FAILING_CONCLUSIONS.has(conclusion)
          ? "failing"
          : "passing";
    const app = asRecord(rec.app);
    const item: CheckItem = {
      name: rec.name,
      kind: "check_run",
      verdict,
      detail: conclusion ?? status,
      url:
        typeof rec.html_url === "string"
          ? rec.html_url
          : typeof rec.details_url === "string"
            ? rec.details_url
            : "",
      actionsJobId: app?.slug === "github-actions" ? rec.id : null,
    };
    const prior = newest.get(rec.name);
    if (!prior || rec.id > prior.id) newest.set(rec.name, { id: rec.id, item });
  }
  return [...newest.values()].map((v) => v.item);
}

/**
 * `GET /commits/{sha}/status` → items. The combined `state` is NOT
 * used: GitHub reports `pending` for a commit with no statuses at all,
 * which would make every Actions-only repo look stuck.
 */
export function parseCommitStatuses(raw: unknown): CheckItem[] {
  const statuses = asRecord(raw)?.statuses;
  if (!Array.isArray(statuses)) {
    throw new GithubApiError("GitHub returned a malformed commit status.", 0);
  }
  const items: CheckItem[] = [];
  const seen = new Set<string>();
  // GitHub lists the newest status per context first.
  for (const entry of statuses) {
    const rec = asRecord(entry);
    if (typeof rec?.context !== "string" || typeof rec.state !== "string") continue;
    if (seen.has(rec.context)) continue;
    seen.add(rec.context);
    const verdict: CheckVerdict =
      rec.state === "success"
        ? "passing"
        : rec.state === "pending"
          ? "pending"
          : "failing";
    items.push({
      name: rec.context,
      kind: "status",
      verdict,
      detail: rec.state,
      url: typeof rec.target_url === "string" ? rec.target_url : "",
      actionsJobId: null,
    });
  }
  return items;
}

/** One verdict for the head: any red wins, then any still running, then green. */
export function summarizeChecks(items: readonly CheckItem[]): ChecksSummary {
  const failing = items.filter((i) => i.verdict === "failing");
  const pending = items.filter((i) => i.verdict === "pending");
  const passing = items.filter((i) => i.verdict === "passing");
  const state: ChecksState =
    failing.length > 0
      ? "failure"
      : pending.length > 0
        ? "pending"
        : passing.length > 0
          ? "success"
          : "none";
  return { state, failing, pending, passing };
}
