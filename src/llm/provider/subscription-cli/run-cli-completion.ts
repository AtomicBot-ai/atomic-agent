import { runCommand } from "../../../sandbox/command-runner.js";
import { cliChildEnv } from "./cli-child-env.js";
import {
  isEnoent,
  isSpawnEinval,
  mapCliFailure,
  SubscriptionCliNotInstalledError,
  SubscriptionCliSpawnError,
} from "./subscription-cli-errors.js";
import { resolveWindowsCliInvocation } from "./windows-cli-shim.js";

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
  /**
   * Variables to leave out of the child's environment
   * (`CliAdapterDescriptor.billingEnvKeys`); absent inherits it whole.
   */
  stripEnv?: readonly string[];
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
  // On Windows the vendor CLIs are `.cmd` shims, which spawn refuses to
  // start without a shell; elsewhere this hands the pair straight back.
  const invocation = resolveWindowsCliInvocation({
    binary: options.binary,
    args: options.args,
    installHint: options.installHint,
  });
  let result;
  try {
    result = await runCommand(invocation.command, invocation.args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      shell: false,
      // The agent's environment minus what would move the CLI off the
      // subscription — the agent's own provider keys among it
      // (`cliChildEnv`). Nothing is ever set: the CLI authenticates
      // from its own session.
      env: cliChildEnv(options.stripEnv),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (err) {
    // EINVAL is thrown, not emitted, so it reaches us through the
    // promise rejection rather than the child's `error` event.
    if (isSpawnEinval(err)) {
      throw new SubscriptionCliSpawnError(options.binary, options.installHint);
    }
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
