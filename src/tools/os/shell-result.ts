import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import type {
  CommandJobExit,
  CommandJobOutput,
} from "../../sandbox/command-job.js";
import type { GuardVerdict } from "./shell-command-guard/index.js";
import {
  formatShellTimeoutNotice,
  type ResolvedShellTimeout,
} from "./shell-timeout.js";

/**
 * How an `os.shell.run` result is put together, whichever way the
 * command ended — at its exit, at an explicit timeout, detached at the
 * default one, or collected later by a `wait` / `kill`. One renderer so
 * a job's result reads exactly like a fresh run's.
 */

export const GOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GOG_COMPRESS_OPTIONS = {
  maxSummaryLength: 64_000,
  maxTailLines: 10_000,
} as const;

/** What a result says about the command, fixed when it was started. */
export interface ShellCommandFacts {
  cmd: string;
  /** The argv that ran (globs expanded on the direct-exec path). */
  args: string[];
  rawArgs: string[];
  cwd: string;
  /** Ran through the OS subshell rather than a direct exec. */
  shell: boolean;
  commandLine: string;
  /** A bare interpreter ran with nothing after it (F40) — said on the command line. */
  noArguments: boolean;
  /** `gog` output is kept far longer than any other command's. */
  gog: boolean;
  guard: GuardVerdict;
}

export interface ShellResultInput {
  facts: ShellCommandFacts;
  status: "ok" | "error";
  /** Lines said first, above the command line. */
  notices: readonly string[];
  /** The line under the command: `exit: 0`, `still running (job 3, …)`. */
  statusLine: string;
  body: string;
  /** Result-specific fields, placed between the command's and the guard's. */
  details: Record<string, unknown>;
}

export function renderShellResult(input: ShellResultInput): CompressedToolResult {
  const { facts } = input;
  const header = `$ ${facts.commandLine}${facts.noArguments ? " (ran with no arguments)" : ""}\n${input.statusLine}`;
  const output = [...input.notices, header, input.body]
    .filter((part) => part.length > 0)
    .join("\n");
  return compressToolResult(
    {
      tool: "os.shell.run",
      status: input.status,
      output,
      details: {
        cmd: facts.cmd,
        args: facts.args,
        rawArgs: facts.rawArgs,
        cwd: facts.cwd,
        shell: facts.shell,
        ...input.details,
        guardVerdict: facts.guard.action,
        guardRule: facts.guard.rule,
        guardReason: facts.guard.reason,
      },
    },
    facts.gog ? GOG_COMPRESS_OPTIONS : {},
  );
}

/** stdout and stderr, the non-empty ones, separated. */
export function joinShellOutput(output: CommandJobOutput): string {
  return [output.stdout, output.stderr]
    .filter((s) => s.trim().length > 0)
    .join("\n---\n");
}

/**
 * The last `count` non-blank lines, with a marker for what was left
 * out. The result compressor keeps only a short tail of the output; a
 * notice above a long output survives only when the body is already
 * short enough for the notice to be inside that tail.
 */
export function tailShellOutput(text: string, count: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= count) return lines.join("\n");
  return `… [${lines.length - count} earlier lines]\n${lines.slice(-count).join("\n")}`;
}

export function formatExitStatus(exit: CommandJobExit): string {
  return `${exit.exitCode ?? "signal:" + exit.signal}`;
}

/** The result of a command that ran to its exit — fresh, or collected by a `wait`. */
export function renderShellExit(
  facts: ShellCommandFacts,
  exit: CommandJobExit,
  output: CommandJobOutput,
  extra: { notices?: readonly string[]; jobId?: number } = {},
): CompressedToolResult {
  return renderShellResult({
    facts,
    status: exit.exitCode === 0 ? "ok" : "error",
    notices: extra.notices ?? [],
    statusLine: `exit: ${formatExitStatus(exit)}`,
    body: joinShellOutput(output),
    details: {
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs: exit.durationMs,
      timedOut: false,
      ...(extra.jobId === undefined ? {} : { jobId: extra.jobId }),
      truncated: output.truncated,
    },
  });
}

/**
 * The result of a command stopped at the model's own `timeoutMs`. Said
 * first, above the command line: which limit stopped it and what to
 * pass for a longer run.
 */
export function renderShellTimedOut(
  facts: ShellCommandFacts,
  exit: CommandJobExit,
  output: CommandJobOutput,
  timeout: ResolvedShellTimeout,
  notices: readonly string[] = [],
): CompressedToolResult {
  return renderShellResult({
    facts,
    status: "error",
    notices: [...notices, formatShellTimeoutNotice(timeout)],
    statusLine: `exit: ${formatExitStatus(exit)} (timed out)`,
    body: joinShellOutput(output),
    details: {
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs: exit.durationMs,
      timedOut: true,
      timeoutMs: timeout.timeoutMs,
      source: timeout.source,
      truncated: output.truncated,
    },
  });
}
