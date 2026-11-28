import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { requireApproval } from "../../approval/dangerous-tool.js";
import {
  AutofixStore,
  autofixKey,
  autofixWorktreeDir,
  checkAutofixPushTarget,
  decideAttempt,
  enableAutofix,
  fetchPullRequestHead,
  formatRepoSlug,
  recordAutofixPush,
  type GithubApi,
} from "../../github/index.js";
import { refuseWhenRemoteSyncOff, requireGitRemoteApproval, type GitRemoteToolOptions } from "../os/git/git-remote-policy.js";
import {
  autofixPushArgs,
  inspectAutofixWorktree,
  mergeBaseIntoWorktree,
  prepareAutofixWorktree,
  pushAutofixWorktree,
  requireCheckoutOf,
} from "./pr-autofix-git.js";
import { requireNumber, resolveRepo } from "./github-tool-args.js";
import { describeState, saveKeepingWatch, saveUnwatch, saveWatch } from "./pr-autofix-watch-action.js";

const TOOL = "github.pr.autofix";
const ACTIONS = ["status", "enable", "disable", "prepare", "merge-base", "push", "watch", "unwatch"] as const;
type Action = (typeof ACTIONS)[number];

export interface PrAutofixToolOptions extends GitRemoteToolOptions {
  /** Where `pr-autofix/` lives; read per call. */
  stateDir: () => string;
  /**
   * Whether this process runs the task scheduler the background watch
   * rides on (ATO-2516). Omitted: assumed on (tests, embedders).
   */
  isWatcherAvailable?: () => boolean;
  /** Test seam. */
  now?: () => Date;
}

export const WATCHER_OFF_MESSAGE =
  "the background watch needs background tasks on (tasks.enabled and tasks.schedulerEnabled). Nothing was changed; check the PR in this chat instead.";

function parseAction(raw: unknown): Action {
  if (typeof raw === "string" && (ACTIONS as readonly string[]).includes(raw)) return raw as Action;
  throw new Error(`${TOOL}: \`action\` must be one of ${ACTIONS.join(", ")}`);
}

function result(status: "ok" | "error", output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status, output, details }, { maxSummaryLength: 1_500 });
}

/**
 * `github.pr.autofix` (ATO-2331, ATO-2516): the opt-in, the counter,
 * the guarded push and the background watch behind the `pr-autofix`
 * starter skill.
 *
 * - `enable` is the explicit per-PR opt-in and asks under `publish`:
 *   agreeing lets the agent push up to `maxAttempts` fixes to that PR.
 * - `prepare` fetches the PR head into a worktree of its own and lets
 *   this session read in it without a read-scope question.
 * - `merge-base` merges the PR's base into that worktree (conflicts are
 *   left for the model to resolve and commit).
 * - `push` sends the worktree's commit to the PR head branch only,
 *   after the target guard and the attempt cap, through the `git_remote`
 *   approval every push asks. Nothing here skips the approval gate.
 * - `watch` / `unwatch` turn the background watcher on or off for an
 *   enabled PR; it files a round only when CI, a conflict or review
 *   feedback needs one, and every push in a round still asks.
 */
export function buildPrAutofixTool(
  client: () => GithubApi,
  options: PrAutofixToolOptions,
): ToolDefinition {
  const now = options.now ?? (() => new Date());
  return {
    name: TOOL,
    description:
      "Opt-in PR autofix (failing CI, merge conflicts, review comments) for one pull request. Args: `action` (status|enable|disable|prepare|merge-base|push|watch|unwatch), `number` (required), `repo` (owner/name; default origin), `maxAttempts` (enable only, default 3), `everyMinutes` and `notify` (telegram|push; watch only). `enable` asks the user; `prepare` makes a worktree of the PR branch; `merge-base` merges the base branch into it; `push` sends its commit to the PR head branch only (never the default branch, never forced) and stops after maxAttempts; `watch` checks the PR in the background and starts a fix round only when something needs it. May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      // First, like every github.* tool: offline mode and a missing
      // token refuse before anything else is read or written.
      const api = client();
      const action = parseAction(rawArgs.action);
      const ref = await resolveRepo(rawArgs.repo, ctx, TOOL);
      const number = requireNumber(rawArgs.number, TOOL, "number");
      const slug = formatRepoSlug(ref);
      const key = autofixKey(slug, number);
      const store = new AutofixStore(options.stateDir());
      const state = await store.get(key);
      // Always derived, never read from state.json: the file is plain
      // JSON on disk, and a path in it must not choose what gets pushed.
      const dir = autofixWorktreeDir(options.stateDir(), slug, number);
      const base = { repo: slug, number, action };

      if (action === "status") {
        return result("ok", `${slug}#${number} autofix: ${describeState(state, dir)}`, { ...base, state: state ?? null });
      }
      if (action === "disable" || action === "unwatch") {
        const next = await saveUnwatch(store, key, now(), action === "disable");
        const said = action === "disable" ? "off" : describeState(next, dir);
        return result("ok", `${slug}#${number} autofix: ${said}`, { ...base, state: next ?? null });
      }

      const pr = await fetchPullRequestHead(api, ref, number);
      const repo = await api.getRepo(ref.owner, ref.repo);
      const target = checkAutofixPushTarget({
        pr,
        repoSlug: slug,
        defaultBranch: repo.defaultBranch,
        enabledHeadRef: action === "enable" ? pr.headRef : (state?.headRef ?? ""),
      });
      if (!target.ok && (action === "enable" || state?.enabled)) {
        return result("error", `${TOOL}: ${target.reason}. Nothing was changed or pushed.`, { ...base, refused: true });
      }

      if (action === "enable") {
        const next = enableAutofix(pr.headRef, rawArgs.maxAttempts, now());
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: TOOL,
            category: "publish",
            reason: `let the agent push fixes (CI, conflicts, review comments) to ${slug}#${number} (branch ${pr.headRef}), at most ${next.maxAttempts} times`,
            preview: `${pr.title}\n${pr.htmlUrl}\nPushes go to ${pr.headRef} only, never forced; each push asks again.`,
            affectedResources: [`github:${slug}#${number}`],
          },
          ctx.signal,
        );
        const saved = await saveKeepingWatch(store, key, next);
        return result("ok", `${slug}#${number} autofix: ${describeState(saved, dir)}`, { ...base, state: saved ?? next });
      }

      if (action === "watch") {
        if (!state?.enabled) {
          return result("error", `${TOOL}: autofix is off for this pull request; enable it first (that asks the user), then watch.`, { ...base, refused: true });
        }
        if (options.isWatcherAvailable && !options.isWatcherAvailable()) {
          return result("error", `${TOOL}: ${WATCHER_OFF_MESSAGE}`, { ...base, refused: true });
        }
        const saved = await saveWatch(store, key, { sessionId: ctx.sessionId, notify: rawArgs.notify, everyMinutes: rawArgs.everyMinutes }, now());
        return result(
          "ok",
          `${slug}#${number} autofix: ${describeState(saved, dir)}. A fix round starts only when CI fails, the branch has a merge conflict, or the repo's team leaves new review comments; each push still asks.`,
          { ...base, state: saved ?? null },
        );
      }

      const decision = decideAttempt(state, pr.headSha, now());
      if (!decision.ok) {
        if (state?.enabled) await saveKeepingWatch(store, key, decision.state);
        return result("error", `${TOOL}: ${decision.reason}`, { ...base, refused: true, state: decision.state });
      }
      if (!target.ok) throw new Error(`${TOOL}: ${target.reason}`);
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { repo: slug, number });
      if (refused) return refused;
      await requireCheckoutOf(ref, ctx);

      if (action === "prepare" || action === "merge-base") {
        // The user opted this PR in; its worktree is where the fix is
        // read and written, so reading there asks nothing more (ATO-2516).
        options.approvals.readScopeGrants.widen(ctx.sessionId, dir);
      }

      if (action === "prepare") {
        const prepared = await prepareAutofixWorktree(options, { number, headRef: target.target, dir }, ctx);
        const next = { ...decision.state, updatedAt: now().toISOString() };
        await saveKeepingWatch(store, key, next);
        return result(
          "ok",
          `worktree ${prepared.created ? "created" : "updated"} at ${prepared.dir} on ${prepared.localBranch} (PR head ${target.target} @${prepared.headSha.slice(0, 7)}). Edit and commit there (os.git.commit with repo "${prepared.dir}"), then call action "push".`,
          { ...base, ...prepared, state: next },
        );
      }

      if (action === "merge-base") {
        const merged = await mergeBaseIntoWorktree(options, { dir, baseRef: pr.baseRef, headRef: target.target }, ctx);
        const said =
          merged.status === "up-to-date"
            ? `${target.target} already has everything from ${pr.baseRef}; nothing to merge.`
            : merged.status === "merged"
              ? `merged ${pr.baseRef} into the worktree cleanly (@${merged.headSha.slice(0, 7)}). Run the checks there, then call action "push".`
              : `merging ${pr.baseRef} stopped on conflicts in: ${merged.conflicted.join(", ")}. Resolve the conflict markers in those files under ${dir}, keep both sides' intent, then commit with os.git.commit ("repo": "${dir}", "all": true) and call action "push".`;
        return result("ok", said, { ...base, baseRef: pr.baseRef, ...merged });
      }

      // action === "push"
      const { headSha } = await inspectAutofixWorktree({ number, dir }, ctx);
      if (headSha === pr.headSha) {
        return result("error", `${TOOL}: the worktree has no new commit on top of the PR head; commit a fix first.`, { ...base, refused: true });
      }
      const attempt = decision.state.attempts + 1;
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `push autofix attempt ${attempt} of ${decision.state.maxAttempts} to ${slug}#${number} (branch ${target.target})`,
          preview: `git ${autofixPushArgs(target.target).join(" ")}\nfrom: ${dir}\ncommit: ${headSha}`,
          affectedResources: [`github:${slug}`],
        },
        ctx.signal,
      );
      const output = await pushAutofixWorktree(options, { dir, target: target.target }, ctx);
      const next = recordAutofixPush(decision.state, headSha, pr.headSha, now());
      await saveKeepingWatch(store, key, next);
      return result(
        "ok",
        `${output}\nautofix attempt ${next.attempts} of ${next.maxAttempts} pushed to ${target.target}.${next.paused ? " Cap reached: autofix is now paused for this PR." : " Wait for CI, then check again with github.pr.checks."}`,
        { ...base, pushedSha: headSha, state: next, ...(decision.resetByHumanPush ? { resetByHumanPush: true } : {}) },
      );
    },
  };
}
