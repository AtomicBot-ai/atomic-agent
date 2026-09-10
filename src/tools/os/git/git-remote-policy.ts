import { compressToolResult, type CompressedToolResult } from "../../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import {
  buildCredentialInjection,
  readGithubToken,
  redactSecret,
  sshBatchEnv,
} from "./git-credentials.js";
import { runGit, type GitRunOptions, type GitRunResult } from "./git-runner.js";

/**
 * What every network git tool is built with. The remote-sync switch is a
 * predicate, injected by the bootstrap from `config.git.remoteSync`, so a
 * toggle in the Integrations hub is honoured on the next call; the tools
 * never read config. `env` is where the GitHub token is read from.
 */
export interface GitRemoteToolOptions extends DangerousToolOptions {
  isRemoteSyncEnabled: () => boolean;
  env?: NodeJS.ProcessEnv;
}

export const REMOTE_SYNC_OFF_MESSAGE =
  "remote sync is off — this repository stays on this machine. Nothing was sent or fetched. The operator can turn it on under Integrations → GitHub → Remote sync; do not look for another way to reach the remote.";

/**
 * The closed-repository check. Runs before any approval prompt and
 * before git is spawned: a structured error the model can read, never
 * a thrown exception, so the turn continues with the operator's answer.
 */
export function refuseWhenRemoteSyncOff(
  tool: string,
  options: GitRemoteToolOptions,
  details: Record<string, unknown> = {},
): CompressedToolResult | null {
  if (options.isRemoteSyncEnabled()) return null;
  return compressToolResult({
    tool,
    status: "error",
    output: `${tool}: ${REMOTE_SYNC_OFF_MESSAGE}`,
    details: { ...details, remoteSync: false, refused: true },
  });
}

export interface GitRemoteApprovalRequest {
  sessionId: string;
  tool: string;
  reason: string;
  preview: string;
  affectedResources: string[];
}

/** One funnel for every network verb: category `git_remote`, always. */
export async function requireGitRemoteApproval(
  options: DangerousToolOptions,
  request: GitRemoteApprovalRequest,
  signal: AbortSignal,
): Promise<void> {
  await requireApproval(
    options,
    {
      sessionId: request.sessionId,
      tool: request.tool,
      category: "git_remote",
      reason: request.reason,
      preview: request.preview,
      affectedResources: request.affectedResources,
    },
    signal,
  );
}

/**
 * Run a network git verb with the token (if any) injected for
 * github.com only, SSH in batch mode, and every byte of output scrubbed
 * of the token before it can reach the transcript or the trace.
 */
export async function runGitRemote(
  options: GitRemoteToolOptions,
  run: Omit<GitRunOptions, "env">,
): Promise<GitRunResult> {
  const env = options.env ?? process.env;
  const token = readGithubToken(env);
  const injection = buildCredentialInjection(token);
  const result = await runGit({
    ...run,
    args: [...injection.args, ...run.args],
    env: { ...sshBatchEnv(env), ...injection.env },
  });
  return {
    ...result,
    stdout: redactSecret(result.stdout, token),
    stderr: redactSecret(result.stderr, token),
    // `args` echo the helper string, not the token, but scrub anyway.
    args: result.args.map((a) => redactSecret(a, token)),
  };
}

/** Git's non-zero exit as a structured error result, output scrubbed already. */
export function gitFailureResult(
  tool: string,
  result: GitRunResult,
  details: Record<string, unknown>,
): CompressedToolResult {
  const stderr = result.stderr.trim() || result.stdout.trim() || "(no output)";
  const why = result.timedOut
    ? `git timed out after ${result.durationMs}ms`
    : `git exited with ${result.exitCode}`;
  return compressToolResult({
    tool,
    status: "error",
    output: `${tool}: ${why}\n${stderr}`,
    details: { ...details, exitCode: result.exitCode, timedOut: result.timedOut },
  });
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
