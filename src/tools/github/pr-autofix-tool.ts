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
  type AutofixState,
  type GithubApi,
} from "../../github/index.js";
import { refuseWhenRemoteSyncOff, requireGitRemoteApproval, type GitRemoteToolOptions } from "../os/git/git-remote-policy.js";
import {
  autofixPushArgs,
  inspectAutofixWorktree,
  prepareAutofixWorktree,
  pushAutofixWorktree,
  requireCheckoutOf,
} from "./pr-autofix-git.js";
import { requireNumber, resolveRepo } from "./github-tool-args.js";

const TOOL = "github.pr.autofix";
const ACTIONS = ["status", "enable", "disable", "prepare", "push"] as const;
type Action = (typeof ACTIONS)[number];

export interface PrAutofixToolOptions extends GitRemoteToolOptions {
  /** Where `pr-autofix/` lives; read per call. */
  stateDir: () => string;
  /** Test seam. */
  now?: () => Date;
}

function parseAction(raw: unknown): Action {
  if (typeof raw === "string" && (ACTIONS as readonly string[]).includes(raw)) return raw as Action;
  throw new Error(`${TOOL}: \`action\` must be one of ${ACTIONS.join(", ")}`);
}

function describeState(state: AutofixState | undefined, dir: string): string {
  if (!state) return "off (never enabled)";
  if (!state.enabled) return "off";
  return `${state.paused ? "paused" : "on"}, ${state.attempts} of ${state.maxAttempts} attempts used, branch ${state.headRef}, worktree ${dir}`;
}

function result(status: "ok" | "error", output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status, output, details }, { maxSummaryLength: 1_500 });
}

/**
 * `github.pr.autofix` (ATO-2331): the opt-in, the counter and the
 * guarded push behind the `pr-autofix` starter skill.
 *
 * - `enable` is the explicit per-PR opt-in and asks under `publish`:
 *   agreeing lets the agent push up to `maxAttempts` fixes to that PR.
 * - `prepare` fetches the PR head into a worktree of its own.
 * - `push` sends the worktree's commit to the PR head branch only,
 *   after the target guard and the attempt cap, through the `git_remote`
 *   approval every push asks. Nothing here skips the approval gate.
 */
export function buildPrAutofixTool(
  client: () => GithubApi,
  options: PrAutofixToolOptions,
): ToolDefinition {
  const now = options.now ?? (() => new Date());
  return {
    name: TOOL,
    description:
      "Opt-in CI autofix for one pull request. Args: `action` (status|enable|disable|prepare|push), `number` (required), `repo` (owner/name; default origin), `maxAttempts` (enable only, default 3). `enable` asks the user; `prepare` makes a worktree of the PR branch; `push` sends its commit to the PR head branch only (never the default branch, never forced) and stops after maxAttempts. May require approval.",
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
      if (action === "disable") {
        if (state) await store.set(key, { ...state, enabled: false, updatedAt: now().toISOString() });
        return result("ok", `${slug}#${number} autofix: off`, { ...base, enabled: false });
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
            reason: `let the agent push CI fixes to ${slug}#${number} (branch ${pr.headRef}), at most ${next.maxAttempts} times`,
            preview: `${pr.title}\n${pr.htmlUrl}\nPushes go to ${pr.headRef} only, never forced; each push asks again.`,
            affectedResources: [`github:${slug}#${number}`],
          },
          ctx.signal,
        );
        await store.set(key, next);
        return result("ok", `${slug}#${number} autofix: ${describeState(next, dir)}`, { ...base, state: next });
      }

      const decision = decideAttempt(state, pr.headSha, now());
      if (!decision.ok) {
        if (state?.enabled) await store.set(key, decision.state);
        return result("error", `${TOOL}: ${decision.reason}`, { ...base, refused: true, state: decision.state });
      }
      if (!target.ok) throw new Error(`${TOOL}: ${target.reason}`);
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { repo: slug, number });
      if (refused) return refused;
      await requireCheckoutOf(ref, ctx);

      if (action === "prepare") {
        const prepared = await prepareAutofixWorktree(options, { number, headRef: target.target, dir }, ctx);
        const next = { ...decision.state, updatedAt: now().toISOString() };
        await store.set(key, next);
        return result(
          "ok",
          `worktree ${prepared.created ? "created" : "updated"} at ${prepared.dir} on ${prepared.localBranch} (PR head ${target.target} @${prepared.headSha.slice(0, 7)}). Edit and commit there (os.git.commit with repo "${prepared.dir}"), then call action "push".`,
          { ...base, ...prepared, state: next },
        );
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
          reason: `push CI fix attempt ${attempt} of ${decision.state.maxAttempts} to ${slug}#${number} (branch ${target.target})`,
          preview: `git ${autofixPushArgs(target.target).join(" ")}\nfrom: ${dir}\ncommit: ${headSha}`,
          affectedResources: [`github:${slug}`],
        },
        ctx.signal,
      );
      const output = await pushAutofixWorktree(options, { dir, target: target.target }, ctx);
      const next = recordAutofixPush(decision.state, headSha, pr.headSha, now());
      await store.set(key, next);
      return result(
        "ok",
        `${output}\nautofix attempt ${next.attempts} of ${next.maxAttempts} pushed to ${target.target}.${next.paused ? " Cap reached: autofix is now paused for this PR." : " Wait for CI, then check again with github.pr.checks."}`,
        { ...base, pushedSha: headSha, state: next, ...(decision.resetByHumanPush ? { resetByHumanPush: true } : {}) },
      );
    },
  };
}

