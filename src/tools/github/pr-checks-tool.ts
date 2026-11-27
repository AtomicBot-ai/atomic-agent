import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  fetchChecks,
  fetchJobLogTail,
  fetchPullRequestHead,
  formatRepoSlug,
  hasMergeConflict,
  type CheckItem,
  type GithubApi,
} from "../../github/index.js";
import { requireNumber, resolveRepo } from "./github-tool-args.js";
import {
  PR_CHECKS_FEEDBACK_BUDGET_CHARS,
  feedbackDetails,
  feedbackLines,
  hasFeedbackItems,
  mergeLine,
  parseSince,
  readFeedback,
} from "./pr-checks-feedback.js";

const TOOL = "github.pr.checks";
/** Failing Actions jobs whose log tail is fetched per call. */
export const PR_CHECKS_MAX_LOGS = 2;
/** Characters of log tail across all jobs shown in one result. */
export const PR_CHECKS_LOG_BUDGET_CHARS = 5_000;
/**
 * The whole report survives ingestion: under the 8 000-char fresh
 * render cap, so the log tails reach the model on the turn that fixes.
 */
const PR_CHECKS_CAPS = { maxSummaryLength: 7_500, maxTailLines: 10_000 };

function line(item: CheckItem): string {
  const mark =
    item.verdict === "failing" ? "FAIL" : item.verdict === "pending" ? "WAIT" : "PASS";
  return `${mark} ${item.name} (${item.detail})${item.url ? ` ${item.url}` : ""}`;
}

/**
 * `github.pr.checks` (ATO-2331, ATO-2516): the CI verdict on a PR's
 * head commit, every red and running check, the log tail of up to two
 * failing GitHub Actions jobs, whether the PR has a merge conflict, and
 * the review feedback from the repo's team. Read-only. Logs and
 * comments are written by other people, so the result is framed as
 * untrusted.
 */
export function buildPrChecksTool(client: () => GithubApi): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Status of a pull request for fixing it: CI verdict, failing and pending checks, the log tail of failing GitHub Actions jobs, merge conflict with the base, and review feedback from the repo's team. Args: `number` (required), `repo` (owner/name; default origin), `logs` (default true), `reviews` (default true), `since` (ISO time; only feedback after it). Read-only.",
    readonly: true,
    untrustedOutput: "GitHub CI logs and review comments",
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, TOOL);
      const number = requireNumber(rawArgs.number, TOOL, "number");
      const wantLogs = rawArgs.logs !== false;
      const wantReviews = rawArgs.reviews !== false;
      const since = parseSince(rawArgs.since);
      const api = client();
      const pr = await fetchPullRequestHead(api, ref, number);
      const summary = await fetchChecks(api, ref, pr.headSha);
      const slug = formatRepoSlug(ref);

      const out: string[] = [
        `${slug}#${pr.number} ${pr.headRef} @${pr.headSha.slice(0, 7)}: ${summary.state} (${summary.failing.length} failing, ${summary.pending.length} pending, ${summary.passing.length} passing)`,
        mergeLine(pr),
        ...summary.failing.map(line),
        ...summary.pending.map(line),
      ];
      const feedback = wantReviews ? await readFeedback(api, ref, pr.number, since) : null;
      if (feedback) out.push(...feedbackLines(feedback, since));
      const logs: Array<Record<string, unknown>> = [];
      if (wantLogs) {
        const withLogs = summary.failing.filter((i) => i.actionsJobId !== null);
        const shown = withLogs.slice(0, PR_CHECKS_MAX_LOGS);
        // Split one log budget between the jobs shown, so the second
        // tail is not the part the summary cap cuts off.
        // Review feedback shown above takes its share of the same cap.
        const budget = PR_CHECKS_LOG_BUDGET_CHARS - (hasFeedbackItems(feedback) ? PR_CHECKS_FEEDBACK_BUDGET_CHARS : 0);
        const perLogChars = Math.floor(budget / Math.max(1, shown.length));
        for (const item of shown) {
          const res = await fetchJobLogTail(api, ref, item.actionsJobId!, perLogChars);
          if (!res.ok) {
            out.push(`--- log: ${item.name}: not available (${res.reason})`);
            logs.push({ check: item.name, jobId: item.actionsJobId, available: false });
            continue;
          }
          const { tail } = res;
          out.push(
            `--- log: ${item.name} (job ${item.actionsJobId}), last lines${tail.truncated ? " (cut)" : ""} ---`,
          );
          if (tail.errorLines.length > 0) {
            out.push("errors:", ...tail.errorLines, "tail:");
          }
          out.push(tail.text || "(empty log)");
          logs.push({
            check: item.name,
            jobId: item.actionsJobId,
            available: true,
            truncated: tail.truncated,
            totalLines: tail.totalLines,
          });
        }
        if (withLogs.length > PR_CHECKS_MAX_LOGS) {
          out.push(`(${withLogs.length - PR_CHECKS_MAX_LOGS} more failing jobs not shown)`);
        }
      }
      return compressToolResult(
        {
          tool: TOOL,
          status: "ok",
          output: out.join("\n"),
          details: {
            repo: slug,
            number: pr.number,
            headRef: pr.headRef,
            headSha: pr.headSha,
            state: summary.state,
            mergeConflict: hasMergeConflict(pr),
            mergeable: pr.mergeable,
            ...(feedback ? { feedback: feedbackDetails(feedback) } : {}),
            failing: summary.failing.map((i) => i.name),
            pending: summary.pending.map((i) => i.name),
            passing: summary.passing.length,
            logs,
          },
        },
        PR_CHECKS_CAPS,
      );
    },
  };
}
