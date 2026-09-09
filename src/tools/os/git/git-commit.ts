import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { FsDangerousToolOptions } from "../fs-require-approval.js";
import { buildGitErrorResult, describeGitFailure } from "./git-error-result.js";
import {
  formatGitCommandLine,
  requireGitMutationApproval,
} from "./git-mutation-approval.js";
import { describeHead, resolveGitToplevel } from "./git-repo-probe.js";
import { runGit, type GitRunResult } from "./git-runner.js";

const TOOL = "os.git.commit";
// Hooks (pre-commit, commit-msg) run as the user's repo configures them
// and may take a while (formatters, test runners), so allow more than the
// runner's 15 s default.
const COMMIT_TIMEOUT_MS = 120_000;

const NOTHING_TO_COMMIT = /nothing (?:added )?to commit|no changes added to commit/i;
const NO_IDENTITY =
  /tell me who you are|unable to auto-detect email|empty ident|no (?:email|name) was given/i;
const IDENTITY_HINT =
  "hint: os.git.init accepts userName / userEmail to set a repo-local identity, or the user can run `git config --global user.name …` and `user.email …`.";

export interface GitCommitStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface CommitArgs {
  repo?: string;
  message: string;
  all: boolean;
}

/**
 * `os.git.commit` — record the staged changes. No `--amend` and no
 * `--no-verify`: history is only ever appended, and the repository's own
 * hooks run exactly as they would for the user.
 */
export function buildOsGitCommitTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Commit staged changes with `message` (`git commit -m`); `all: true` also commits tracked modifications (`-a`). Commit signing is switched off for the call. Requires approval like a file write in the repository.",
    readonly: false,
    async run(rawArgs, ctx) {
      const parsed = parseArgs(rawArgs);
      if (!parsed.ok) return buildGitErrorResult(TOOL, parsed.message);
      const args = parsed.value;
      const probe = { repo: args.repo, workingDir: ctx.workingDir, signal: ctx.signal };

      const toplevel = await resolveGitToplevel(probe);
      if (!toplevel.ok) return buildGitErrorResult(TOOL, `${TOOL}: ${toplevel.message}`);

      // `-c commit.gpgsign=false` goes before the subcommand so it wins over
      // the repository's config: the agent has no terminal to answer a gpg
      // pinentry, so a signing prompt would hang the turn until the
      // timeout instead of producing a commit.
      const gitArgs = [
        "-c",
        "commit.gpgsign=false",
        "commit",
        ...(args.all ? ["-a"] : []),
        "-m",
        args.message,
      ];

      await requireGitMutationApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          repoRoot: toplevel.root,
          reason: `git commit in ${toplevel.root}`,
          preview: formatGitCommandLine(gitArgs),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      const result = await runGit({
        ...probe,
        args: gitArgs,
        timeoutMs: COMMIT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return classifyFailure(result, toplevel.root);
      }

      const [show, head] = await Promise.all([
        runGit({
          ...probe,
          args: ["show", "--shortstat", "--format=%H%x00%h%x00%s", "HEAD"],
        }),
        describeHead(probe),
      ]);
      if (show.exitCode !== 0) {
        return buildGitErrorResult(TOOL, describeGitFailure(show), {
          repoRoot: toplevel.root,
        });
      }
      const summary = parseShow(show.stdout);
      const branch = head.branch ?? "(detached)";
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: [
          `[${branch} ${summary.shortHash}] ${summary.subject}`,
          ` ${formatStat(summary.stat)}`,
        ].join("\n"),
        details: {
          repoRoot: toplevel.root,
          branch: head.branch,
          hash: summary.hash,
          shortHash: summary.shortHash,
          subject: summary.subject,
          ...summary.stat,
          all: args.all,
        },
      });
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
): { ok: true; value: CommitArgs } | { ok: false; message: string } {
  const message = typeof rawArgs.message === "string" ? rawArgs.message.trim() : "";
  if (message.length === 0) {
    return {
      ok: false,
      message: `${TOOL}: \`message\` is required and must not be blank`,
    };
  }
  const repo = typeof rawArgs.repo === "string" && rawArgs.repo.length > 0
    ? rawArgs.repo
    : undefined;
  const value: CommitArgs = { message, all: rawArgs.all === true };
  if (repo !== undefined) value.repo = repo;
  return { ok: true, value };
}

function classifyFailure(result: GitRunResult, root: string) {
  const text = describeGitFailure(result);
  if (NOTHING_TO_COMMIT.test(text)) {
    return buildGitErrorResult(
      TOOL,
      `${TOOL}: nothing to commit in ${root} — stage changes with os.git.add first (or pass all: true to include tracked modifications).\n${text}`,
      { repoRoot: root, reason: "nothing_to_commit" },
    );
  }
  if (NO_IDENTITY.test(text)) {
    return buildGitErrorResult(TOOL, `${text}\n${IDENTITY_HINT}`, {
      repoRoot: root,
      reason: "no_identity",
    });
  }
  return buildGitErrorResult(TOOL, text, { repoRoot: root });
}

/**
 * `git show --shortstat --format=%H%x00%h%x00%s HEAD` prints
 * `<hash>\0<short>\0<subject>` on the first line and, after a blank line,
 * ` N files changed, X insertions(+), Y deletions(-)` (each stat part
 * only when non-zero). `show` — not `diff-tree` — so the root commit
 * reports its stat too.
 */
function parseShow(stdout: string): {
  hash: string;
  shortHash: string;
  subject: string;
  stat: GitCommitStat;
} {
  const [header = "", ...rest] = stdout.split(/\r?\n/);
  const [hash = "", shortHash = "", subject = ""] = header.split("\0");
  const statLine = rest.find((line) => /files? changed/.test(line)) ?? "";
  const files = /(\d+) files? changed/.exec(statLine);
  const insertions = /(\d+) insertions?\(\+\)/.exec(statLine);
  const deletions = /(\d+) deletions?\(-\)/.exec(statLine);
  return {
    hash,
    shortHash,
    subject,
    stat: {
      filesChanged: files ? Number(files[1]) : 0,
      insertions: insertions ? Number(insertions[1]) : 0,
      deletions: deletions ? Number(deletions[1]) : 0,
    },
  };
}

function formatStat(stat: GitCommitStat): string {
  return `${stat.filesChanged} file(s) changed, ${stat.insertions} insertion(s)(+), ${stat.deletions} deletion(s)(-)`;
}
