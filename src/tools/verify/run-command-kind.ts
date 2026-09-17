/**
 * `kind: "command"` — any test runner, compiler, script or CLI, run to
 * completion in the throwaway copy.
 */
import type { VerifyRunArgs } from "./verify-run-args.js";
import { spawnVerifyProcess } from "./spawn-verify-process.js";

export interface CommandRunOutcome {
  readonly commandLine: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  /** Full captured output (capped) — for checks. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export async function runCommandKind(
  args: VerifyRunArgs,
  ctx: { cwd: string; signal?: AbortSignal },
): Promise<CommandRunOutcome> {
  const started = Date.now();
  const proc = spawnVerifyProcess(args.cmd ?? "", args.args ?? [], {
    cwd: ctx.cwd,
    env: args.env,
    network: args.network,
    timeoutMs: args.timeoutMs,
    signal: ctx.signal,
  });
  const exit = await proc.exited;
  return {
    commandLine: proc.commandLine,
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut: exit.timedOut,
    aborted: exit.aborted,
    ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
    stdout: proc.stdout.all(),
    stderr: proc.stderr.all(),
    stdoutTail: proc.stdout.tail(),
    stderrTail: proc.stderr.tail(),
    durationMs: Date.now() - started,
  };
}
