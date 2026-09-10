import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import { hasEmbeddedUserinfo } from "./git-credentials.js";
import {
  gitFailureResult,
  optionalString,
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
  runGitRemote,
  type GitRemoteToolOptions,
} from "./git-remote-policy.js";

const TOOL = "os.git.clone";
const CLONE_TIMEOUT_MS = 300_000;

/** Clone a repository into the workspace (or a named destination). */
export function buildOsGitCloneTool(
  options: GitRemoteToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Clone a repository. `url` required; `dest` defaults to the repo name under the working directory; optional `branch`, `depth`. Needs Remote sync on; asks for approval. URLs with embedded credentials are refused.",
    readonly: false,
    async run(rawArgs, ctx) {
      const url = optionalString(rawArgs.url);
      if (!url) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: \`url\` is required`,
          details: {},
        });
      }
      if (hasEmbeddedUserinfo(url)) {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: refusing a URL with embedded credentials — it would be written to .git/config. Use a plain URL; the token from Integrations → GitHub is supplied at clone time.`,
          details: { refused: true },
        });
      }
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { url });
      if (refused) return refused;

      const destArg = optionalString(rawArgs.dest);
      const dest = destArg
        ? resolveUserPath(destArg, ctx.workingDir)
        : resolve(ctx.workingDir, repoNameFromUrl(url));
      const parent = dirname(dest);
      try {
        await stat(dest);
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: destination ${dest} already exists`,
          details: { url, dest },
        });
      } catch {
        // A missing destination is the normal case.
      }
      try {
        if (!(await stat(parent)).isDirectory()) throw new Error("not a directory");
      } catch {
        return compressToolResult({
          tool: TOOL,
          status: "error",
          output: `${TOOL}: parent folder ${parent} does not exist — create it first or pick another dest`,
          details: { url, dest, parent },
        });
      }
      const branch = optionalString(rawArgs.branch);
      const depth =
        typeof rawArgs.depth === "number" && Number.isInteger(rawArgs.depth) && rawArgs.depth > 0
          ? rawArgs.depth
          : undefined;
      const args = ["clone"];
      if (branch) args.push("--branch", branch);
      if (depth !== undefined) args.push("--depth", String(depth));
      args.push("--", url, dest);
      const preview = `git ${args.join(" ")}`;
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `clone ${url} into ${dest}`,
          preview,
          affectedResources: [dest],
        },
        ctx.signal,
      );
      const result = await runGitRemote(options, {
        repo: parent,
        workingDir: ctx.workingDir,
        args,
        signal: ctx.signal,
        timeoutMs: CLONE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return gitFailureResult(TOOL, result, { url, dest });
      }
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: `${preview}\n${result.stderr.trim() || "cloned"}`,
        details: { url, dest, branch: branch ?? null, depth: depth ?? null },
      });
    },
  };
}

/** `https://github.com/x/y.git` → `y`; `git@github.com:x/y` → `y`. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.replace(/[/\\]+$/, "");
  const last = basename(cleaned.replace(/:([^/]+)$/, "/$1"));
  return last.replace(/\.git$/i, "") || "repo";
}
