import { existsSync } from "node:fs";

import { loadNodePty, type NodePtyModule } from "../../../native/load-node-pty.js";
import { startCommandJob, type CommandJob } from "../../../sandbox/command-job.js";
import { startPtyCommandJob } from "../../../sandbox/pty-command-job.js";
import { wrapForTty } from "./tty-wrap.js";

/**
 * Start a `tty: true` job (ATO-2277) on the best terminal this machine
 * has (ATO-2484), in this order:
 *
 * 1. `pty`: node-pty (`@lydell/node-pty`, shipped next to the binary):
 *    a real pty on macOS and Linux, ConPTY on Windows, with a terminal
 *    size the job can change. Precedent: Gemini CLI's shell service.
 * 2. `script`: the system `script(1)` on macOS and Linux (tty-wrap.ts),
 *    when the binding is missing or does not load.
 * 3. `pipes`: plain stdin and stdout; the program sees no terminal, and
 *    the result says so.
 *
 * Every backend returns the same `CommandJob`, so the job registry and
 * `write` / `wait` / `kill` do not care which one runs.
 */

export type TtyBackend = "pty" | "script" | "pipes";

export interface InteractiveSpawn {
  command: string;
  args: string[];
  /** Windows: `args` is a ready `cmd.exe` command line. */
  windowsVerbatimArguments?: boolean;
}

export interface InteractiveJobOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface InteractiveJobDeps {
  /** Test seam; the real loader caches its answer per process. */
  loadPty?: () => NodePtyModule | null;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

export interface StartedInteractiveJob {
  job: CommandJob;
  backend: TtyBackend;
}

export function startInteractiveJob(
  spawnSpec: InteractiveSpawn,
  options: InteractiveJobOptions,
  deps: InteractiveJobDeps = {},
): StartedInteractiveJob {
  const pty = (deps.loadPty ?? loadNodePty)();
  if (pty !== null) {
    const job = startPtyCommandJob(pty, spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd,
      env: options.env,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    });
    // A pty that cannot start the program (ConPTY's own file lookup is
    // not the shell's) is not the end: the same spawn runs on pipes or
    // script(1) below, where a real failure reports as it always did.
    if (job.startError() === null) return { job, backend: "pty" };
  }
  const wrapped = wrapForTty(
    spawnSpec.command,
    spawnSpec.args,
    deps.platform ?? process.platform,
    deps.exists ?? existsSync,
  );
  const job = startCommandJob(wrapped.command, wrapped.args, {
    cwd: options.cwd,
    env: options.env,
    keepStdinOpen: true,
    stopDescendants: true,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    // The script wrapper is a POSIX argv; only the bare pipes keep the
    // Windows command line as it was built.
    ...(!wrapped.tty && spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return { job, backend: wrapped.tty ? "script" : "pipes" };
}
