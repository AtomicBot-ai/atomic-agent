import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { hasEmbeddedUserinfo } from "./git-credentials.js";
import {
  gitFailureResult,
  optionalString,
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
  type GitRemoteToolOptions,
} from "./git-remote-policy.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

const TOOL = "os.git.remote";
type RemoteAction = "list" | "add" | "remove" | "set-url";

export interface GitRemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Manage a repository's remotes. `list` is read-only and always allowed.
 * `add` / `set-url` are the step before the first push, so they honour
 * the remote-sync switch and take a `git_remote` approval; `remove`
 * takes the approval but works with the switch off — cutting a remote
 * only makes a repository more local. A URL carrying `user:token@` is
 * refused for any host: it would persist the credential in
 * `.git/config` and echo it in every `git remote -v`.
 */
export function buildOsGitRemoteTool(
  options: GitRemoteToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Manage remotes. `action`: \"list\" (default, read-only), \"add\" {name, url}, \"set-url\" {name, url}, \"remove\" {name}. Adding or re-pointing a remote needs Remote sync on and asks for approval; URLs with embedded credentials are refused.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = optionalString(rawArgs.repo);
      const action = parseAction(rawArgs.action);
      if (action === null) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: \`action\` must be one of list, add, remove, set-url`,
          details: { action: rawArgs.action ?? null },
        });
      }
      if (action === "list") return listRemotes(repo, ctx);

      const name = optionalString(rawArgs.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: \`name\` must be a plain remote name (letters, digits, . _ -)`,
          details: { action, name: name ?? null },
        });
      }
      const url = action === "remove" ? undefined : optionalString(rawArgs.url);
      if (action !== "remove") {
        if (!url) {
          return compressToolResult({
            tool: TOOL,
            status: "error",
            output: `${TOOL}: \`url\` is required for ${action}`,
            details: { action, name },
          });
        }
        if (hasEmbeddedUserinfo(url)) {
          return compressToolResult({
            tool: TOOL,
            status: "error",
            output: `${TOOL}: refusing a URL with embedded credentials — it would be written to .git/config. Use a plain https://github.com/... URL; the token from Integrations → GitHub is supplied at push time.`,
            details: { action, name, refused: true },
          });
        }
        const refused = refuseWhenRemoteSyncOff(TOOL, options, { action, name });
        if (refused) return refused;
      }

      const gitArgs =
        action === "add"
          ? ["remote", "add", name, url!]
          : action === "set-url"
            ? ["remote", "set-url", name, url!]
            : ["remote", "remove", name];
      const preview = `git ${gitArgs.join(" ")}`;
      const probe = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--show-toplevel"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      requireGitSuccess(TOOL, probe);
      const repoRoot = probe.stdout.trim();
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `${action} remote ${name} in ${repoRoot}`,
          preview,
          affectedResources: [repoRoot],
        },
        ctx.signal,
      );
      const result = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: gitArgs,
        signal: ctx.signal,
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0) {
        return gitFailureResult(TOOL, result, { action, name, repoRoot });
      }
      const remotes = await readRemotes(repo, ctx);
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${preview}\n${formatRemotes(remotes)}`,
        details: { action, name, url: url ?? null, remotes, repoRoot },
      });
    },
  };
}

function parseAction(raw: unknown): RemoteAction | null {
  if (raw === undefined || raw === null || raw === "") return "list";
  if (raw === "list" || raw === "add" || raw === "remove" || raw === "set-url") {
    return raw;
  }
  return null;
}

async function listRemotes(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
) {
  const remotes = await readRemotes(repo, ctx);
  return compressToolResult({
    tool: TOOL,
    status: "ok",
    output: formatRemotes(remotes),
    details: { action: "list", remotes, count: remotes.length },
  });
}

async function readRemotes(
  repo: string | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<GitRemoteEntry[]> {
  const result = await runGit({
    repo,
    workingDir: ctx.workingDir,
    args: ["remote", "-v"],
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  requireGitSuccess(TOOL, result);
  const byName = new Map<string, GitRemoteEntry>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    const url = match[2]!;
    const kind = match[3]!;
    const entry = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

function formatRemotes(remotes: readonly GitRemoteEntry[]): string {
  if (remotes.length === 0) return "(no remotes — this repository is local-only)";
  return remotes
    .map((r) =>
      r.fetchUrl === r.pushUrl
        ? `${r.name}\t${r.fetchUrl}`
        : `${r.name}\t${r.fetchUrl} (fetch)\n${r.name}\t${r.pushUrl} (push)`,
    )
    .join("\n");
}
