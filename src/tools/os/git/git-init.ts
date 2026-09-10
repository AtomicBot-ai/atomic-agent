import { realpath, stat } from "node:fs/promises";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import type { FsDangerousToolOptions } from "../fs-require-approval.js";
import { buildGitErrorResult, describeGitFailure } from "./git-error-result.js";
import {
  formatGitCommandLine,
  requireGitMutationApproval,
} from "./git-mutation-approval.js";
import { resolveGitToplevel } from "./git-repo-probe.js";
import { runGit } from "./git-runner.js";

const TOOL = "os.git.init";
const DEFAULT_INITIAL_BRANCH = "main";

interface InitArgs {
  target: string;
  initialBranch: string;
  userName?: string;
  userEmail?: string;
}

/** How `target` relates to git before we touch it. */
type ExistingRepo =
  | { kind: "none" }
  | { kind: "same" }
  | { kind: "nested"; enclosingRoot: string };

/**
 * `os.git.init` — create a local repository, optionally with a repo-local
 * identity so a machine with no global `user.name` / `user.email` can
 * still commit. Never touches global config and never adds a remote.
 */
export function buildOsGitInitTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Create a local git repository (`git init --initial-branch=<name|main>`) at `path` (default: working dir), optionally setting repo-local `userName` / `userEmail`. An existing repository is left as is. Requires approval like a file write in that directory.",
    readonly: false,
    async run(rawArgs, ctx) {
      const parsed = parseArgs(rawArgs, ctx.workingDir);
      if (!parsed.ok) return buildGitErrorResult(TOOL, parsed.message);
      const args = parsed.value;

      const existing = await probeExisting(args.target, ctx.workingDir, ctx.signal);
      if (!existing.ok) return buildGitErrorResult(TOOL, existing.message);
      const alreadyInitialised = existing.value.kind === "same";

      const commands: string[][] = [];
      if (!alreadyInitialised) {
        commands.push([
          "init",
          `--initial-branch=${args.initialBranch}`,
          "--",
          args.target,
        ]);
      }
      if (args.userName !== undefined) {
        commands.push(["config", "user.name", args.userName]);
      }
      if (args.userEmail !== undefined) {
        commands.push(["config", "user.email", args.userEmail]);
      }
      if (commands.length === 0) {
        return compressToolResult({
          tool: TOOL,
          status: "ok",
          output: formatOutput(args, existing.value),
          details: {
            repoRoot: args.target,
            initialBranch: null,
            alreadyInitialised: true,
            userName: null,
            userEmail: null,
            enclosingRepo: null,
          },
        });
      }
      if (!alreadyInitialised) {
        // `git init` validates the branch name only after creating the
        // `.git` skeleton, which would leave a half-made repository
        // behind on a typo; check the name first so nothing is written.
        const check = await runGit({
          workingDir: ctx.workingDir,
          args: ["check-ref-format", "--branch", args.initialBranch],
          signal: ctx.signal,
        });
        if (check.exitCode !== 0) {
          return buildGitErrorResult(
            TOOL,
            `${TOOL}: invalid initial branch name '${args.initialBranch}': ${describeGitFailure(check)}`,
          );
        }
      }

      await requireGitMutationApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          repoRoot: args.target,
          reason: alreadyInitialised
            ? `git config identity in ${args.target}`
            : `git init in ${args.target}`,
          preview: commands.map(formatGitCommandLine).join("\n"),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      for (const command of commands) {
        // `git init <dir>` creates the directory (and its parents) when
        // it does not exist yet, so it runs from the session working dir
        // and names the target explicitly; the identity commands run
        // inside the now-existing repository.
        const result = await runGit({
          repo: command[0] === "init" ? undefined : args.target,
          workingDir: ctx.workingDir,
          args: command,
          signal: ctx.signal,
        });
        if (result.exitCode !== 0) {
          return buildGitErrorResult(TOOL, describeGitFailure(result), {
            repoRoot: args.target,
            alreadyInitialised,
          });
        }
      }

      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output: formatOutput(args, existing.value),
        details: {
          repoRoot: args.target,
          initialBranch: alreadyInitialised ? null : args.initialBranch,
          alreadyInitialised,
          userName: args.userName ?? null,
          userEmail: args.userEmail ?? null,
          enclosingRepo:
            existing.value.kind === "nested"
              ? existing.value.enclosingRoot
              : null,
        },
      });
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): { ok: true; value: InitArgs } | { ok: false; message: string } {
  const path = optionalString(rawArgs.path);
  const initialBranch = optionalString(rawArgs.initialBranch);
  const userName = optionalString(rawArgs.userName);
  const userEmail = optionalString(rawArgs.userEmail);
  for (const [field, value] of [
    ["path", path],
    ["initialBranch", initialBranch],
    ["userName", userName],
    ["userEmail", userEmail],
  ] as const) {
    if (value === "") {
      return { ok: false, message: `${TOOL}: \`${field}\` must be a non-empty string` };
    }
  }
  if (initialBranch !== undefined && initialBranch.startsWith("-")) {
    return { ok: false, message: `${TOOL}: \`initialBranch\` may not start with "-"` };
  }
  const value: InitArgs = {
    target: path !== undefined ? resolveUserPath(path, workingDir) : workingDir,
    initialBranch: initialBranch ?? DEFAULT_INITIAL_BRANCH,
  };
  if (userName !== undefined) value.userName = userName;
  if (userEmail !== undefined) value.userEmail = userEmail;
  return { ok: true, value };
}

/** `undefined` when absent; the raw string otherwise (empty is left for the caller to reject). */
function optionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "string" ? raw.trim() : "";
}

async function probeExisting(
  target: string,
  workingDir: string,
  signal: AbortSignal,
): Promise<{ ok: true; value: ExistingRepo } | { ok: false; message: string }> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return { ok: false, message: `${TOOL}: ${target} exists and is not a directory` };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: { kind: "none" } };
    }
    throw err;
  }
  const toplevel = await resolveGitToplevel({ repo: target, workingDir, signal });
  if (!toplevel.ok) return { ok: true, value: { kind: "none" } };
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(toplevel.root),
    realpath(target),
  ]);
  if (canonicalRoot === canonicalTarget) return { ok: true, value: { kind: "same" } };
  return { ok: true, value: { kind: "nested", enclosingRoot: toplevel.root } };
}

function formatOutput(args: InitArgs, existing: ExistingRepo): string {
  const lines: string[] = [];
  if (existing.kind === "same") {
    lines.push(`${args.target} is already a git repository (not re-initialised)`);
  } else {
    lines.push(
      `initialised empty git repository at ${args.target} (initial branch ${args.initialBranch})`,
    );
  }
  if (existing.kind === "nested") {
    lines.push(`note: nested inside the repository at ${existing.enclosingRoot}`);
  }
  if (args.userName !== undefined || args.userEmail !== undefined) {
    const who = [args.userName, args.userEmail && `<${args.userEmail}>`]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
    lines.push(`repo-local identity: ${who}`);
  }
  return lines.join("\n");
}
