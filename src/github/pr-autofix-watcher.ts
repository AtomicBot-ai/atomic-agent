/**
 * The background PR autofix watcher (ATO-2516), a scheduler sidecar.
 *
 * It replaces the model scheduling its own `tasks.cron` poll: that ran
 * a whole agent turn every 15 minutes just to learn CI was still green.
 * Here the leading process reads GitHub on a timer with plain REST
 * calls (PR head, checks, review feedback; no model, no tokens spent)
 * and files a task, the way the mail and file triggers do, only when a
 * round has work: CI failing on a head not handed over yet, a merge
 * conflict on a head not handed over yet, or new review feedback from
 * the repo's team. The round runs in the chat that turned the watch on,
 * so its report lands there (and goes by Telegram or push when asked).
 *
 * Rules, in order, per watched PR:
 *  - only enabled PRs with a `watch`, each at most every `everyMs`;
 *  - a round whose task is still open blocks the next one;
 *  - a closed or merged PR stops its watch;
 *  - a paused PR (attempt cap reached) files nothing;
 *  - the watch is written before the task is filed, so a crash loses
 *    at most one round and never files two.
 * The task message carries no text from GitHub: the round reads the
 * comments and logs itself through `github.pr.checks`, which frames
 * them as untrusted. Every push in a round still asks for approval.
 */

import type { TaskStatus } from "../tasks/task-types.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { GithubApi } from "./github-api.js";
import { fetchChecks, fetchPullRequestHead } from "./github-checks-api.js";
import { hasMergeConflict, type PullRequestHead } from "./github-checks.js";
import { fetchPrFeedback } from "./github-pr-feedback.js";
import { scrubGithubToken } from "./github-token.js";
import { parseRepoSlug } from "./parse-github-remote.js";
import { decideAttempt, type AutofixState } from "./pr-autofix-guard.js";
import { AutofixStore, parseAutofixKey } from "./pr-autofix-store.js";
import {
  planWatchRound,
  watchDue,
  type AutofixWatch,
  type AutofixWatchNotify,
  type WatchReason,
} from "./pr-autofix-watch-state.js";

/** The state file is read at most this often, however fast the scheduler ticks. */
export const WATCH_SCAN_MS = 60_000;
const OPEN_TASK: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["pending", "running", "paused"]);

export interface PrAutofixWatcherOptions {
  stateDir: () => string;
  /** A client for this tick, or null when offline or GitHub is not connected. */
  client: () => GithubApi | null;
  createTask: (input: {
    sessionId: string | null;
    userMessage: string;
    notify: AutofixWatchNotify | null;
  }) => { id: string };
  /** A task's status, or null when it is gone. */
  taskStatus: (id: string) => TaskStatus | null;
  logger?: Pick<StructuredLogger, "info" | "warn" | "debug">;
}

/** The round's instructions: what to fix and how, never GitHub's own text. */
export function buildWatchRoundMessage(input: {
  slug: string;
  number: number;
  pr: Pick<PullRequestHead, "headRef" | "headSha" | "baseRef">;
  reasons: readonly WatchReason[];
  feedbackSince: string;
}): string {
  const { slug, number, pr } = input;
  const ref = `{"number": ${number}, "repo": "${slug}"}`;
  const lines = [
    `PR autofix watch: pull request #${number} in ${slug} (branch ${pr.headRef}) needs a fix round. Use the pr-autofix skill.`,
  ];
  if (input.reasons.includes("ci")) {
    lines.push(`- CI is failing on ${pr.headSha.slice(0, 7)}. Read it with github.pr.checks ${ref}.`);
  }
  if (input.reasons.includes("conflict")) {
    lines.push(
      `- The branch has a merge conflict with ${pr.baseRef}. After github.pr.autofix "prepare", call "merge-base", resolve the conflicts, commit.`,
    );
  }
  if (input.reasons.includes("review")) {
    lines.push(
      `- New review feedback from the repo's team. Read it with github.pr.checks {"number": ${number}, "repo": "${slug}", "since": "${input.feedbackSince}"}; address each point that asks for a change.`,
    );
  }
  lines.push(
    `Fix only what is listed, in the autofix worktree, and push once with github.pr.autofix "push" (it asks for approval). If autofix says it is paused or off, stop. Reply with a short report: what was wrong, what you changed, the attempt number, or why you stopped.`,
  );
  return lines.join("\n");
}

export class PrAutofixWatcher {
  private busy = false;
  private lastScan = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: PrAutofixWatcherOptions) {}

  /** One scheduler tick. Never throws; overlapping calls are dropped. */
  async tick(nowMs: number, signal?: AbortSignal): Promise<void> {
    if (this.busy || nowMs - this.lastScan < WATCH_SCAN_MS) return;
    this.busy = true;
    this.lastScan = nowMs;
    try {
      await this.scan(nowMs, signal);
    } catch (err) {
      this.options.logger?.warn("pr autofix watch: tick failed", { error: describe(err) });
    } finally {
      this.busy = false;
    }
  }

  private async scan(nowMs: number, signal: AbortSignal | undefined): Promise<void> {
    const store = new AutofixStore(this.options.stateDir());
    const due = Object.entries(await store.all()).filter(
      ([, s]) => s.enabled && s.watch !== undefined && watchDue(s.watch, nowMs),
    );
    if (due.length === 0) return;
    const api = this.options.client();
    if (!api) {
      this.options.logger?.debug("pr autofix watch: GitHub not connected or offline; not polling");
      return;
    }
    for (const [key, state] of due) {
      if (signal?.aborted) return;
      try {
        await this.pollOne(store, api, key, state, new Date(nowMs));
      } catch (err) {
        this.options.logger?.warn("pr autofix watch: poll failed", { pr: key, error: describe(err) });
      }
    }
  }

  private async pollOne(
    store: AutofixStore,
    api: GithubApi,
    key: string,
    state: AutofixState,
    now: Date,
  ): Promise<void> {
    const watch = state.watch!;
    const touch = (fields: Partial<AutofixWatch> = {}) =>
      store.update(key, (cur) =>
        cur?.watch ? { ...cur, watch: { ...cur.watch, lastPollAt: now.toISOString(), ...fields } } : undefined,
      );
    const parsed = parseAutofixKey(key);
    const ref = parsed ? parseRepoSlug(parsed.slug) : null;
    if (!parsed || !ref) return;
    if (watch.taskId !== null) {
      const status = this.options.taskStatus(watch.taskId);
      if (status !== null && OPEN_TASK.has(status)) {
        await touch();
        return;
      }
    }
    const pr = await fetchPullRequestHead(api, ref, parsed.number);
    if (pr.state !== "open") {
      await store.update(key, (cur) => {
        if (!cur) return undefined;
        const { watch: _done, ...rest } = cur;
        void _done;
        return { ...rest, updatedAt: now.toISOString() };
      });
      this.options.logger?.info("pr autofix watch: pull request is not open; watch stopped", { pr: key, state: pr.state });
      return;
    }
    // Cap reached, or the PR now points at another branch: nothing to file.
    if (!decideAttempt(state, pr.headSha, now).ok || pr.headRef !== state.headRef) {
      await touch();
      return;
    }
    const checks = await fetchChecks(api, ref, pr.headSha);
    const feedback = await fetchPrFeedback(api, ref, parsed.number, watch.feedbackSeenAt);
    const plan = planWatchRound(
      watch,
      { headSha: pr.headSha, checks: checks.state, conflict: hasMergeConflict(pr), newestFeedbackAt: feedback.newestAt },
      now,
    );
    if (plan.reasons.length === 0) {
      await touch();
      return;
    }
    // Mark before filing; a watch turned off meanwhile files nothing.
    const marked = await store.update(key, (cur) => (cur?.watch ? { ...cur, watch: { ...plan.next, taskId: null } } : undefined));
    if (!marked?.watch) return;
    const task = this.options.createTask({
      sessionId: watch.sessionId,
      notify: watch.notify,
      userMessage: buildWatchRoundMessage({
        slug: parsed.slug,
        number: parsed.number,
        pr,
        reasons: plan.reasons,
        feedbackSince: watch.feedbackSeenAt,
      }),
    });
    await touch({ taskId: task.id });
    this.options.logger?.info("pr autofix watch: fix round filed", { pr: key, reasons: plan.reasons.join(","), taskId: task.id });
  }
}

function describe(err: unknown): string {
  return scrubGithubToken(err instanceof Error ? err.message : String(err));
}
