import { runCommand } from "../../../sandbox/command-runner.js";
import {
  isEnoent,
  mapCliFailure,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";

export interface CliRunOptions {
  binary: string;
  args: readonly string[];
  /** Prompt text, written to stdin. Never placed on argv — see the provider. */
  input?: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  installHint: string;
  authHint: string;
}

export interface CliRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Injection seam. Tests substitute their own runner so no test ever
 * spawns a real CLI; mirrors `OpenAiProviderOptions.fetchImpl`.
 */
export type CliRunner = (options: CliRunOptions) => Promise<CliRunOutcome>;

/**
 * Run a vendor CLI to completion and hand back its stdout, or throw a
 * typed error. Builds on `runCommand`, which already provides
 * shell-free spawn, stdin injection, timeout, an output cap and Windows
 * tree-kill; this adds the failure taxonomy on top, the same way
 * `git-runner.ts` wraps it for git.
 */
export const runCliCommand: CliRunner = async (options) => {
  let result;
  try {
    result = await runCommand(options.binary, [...options.args], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      shell: false,
      // Inherit the environment untouched. We deliberately neither set
      // nor clear ANTHROPIC_API_KEY: setting it would silently move the
      // user onto API billing, clearing it would break anyone who wants
      // exactly that.
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (isEnoent(err)) {
      throw new SubscriptionCliNotInstalledError(
        options.binary,
        options.installHint,
      );
    }
    throw err;
  }

  // `inputTruncated` is its own failure condition: a CLI that stops
  // reading mid-prompt answered a different question than the one we
  // asked, and `codex` exits 0 even when it fails, so the exit code
  // alone would let that through as a good completion.
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.truncated ||
    result.inputTruncated
  ) {
    throw mapCliFailure({
      binary: options.binary,
      installHint: options.installHint,
      authHint: options.authHint,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      inputTruncated: result.inputTruncated,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
};
