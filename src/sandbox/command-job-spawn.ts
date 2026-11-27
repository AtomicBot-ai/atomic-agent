import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";

import { buildCommandEnv } from "./command-env.js";

const IS_WINDOWS = process.platform === "win32";

export interface JobSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  /**
   * Bytes for the child to read on fd 3: written to a pipe that is then
   * closed (the sandbox's seccomp program for `bwrap --seccomp 3`,
   * ATO-2469). A pipe, never a file: a sandboxed command can write temp,
   * so a file there could be swapped before the next command reads it.
   */
  fd3Input?: Buffer;
}

/**
 * The child of a `CommandJob`: stdin, stdout and stderr piped, a process
 * group of its own on POSIX, and, when asked, fd 3 fed and closed.
 */
export function spawnJobChild(
  command: string,
  args: string[],
  options: JobSpawnOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? buildCommandEnv(process.env),
    stdio:
      options.fd3Input === undefined
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", "pipe"],
    // A group of its own on POSIX; on Windows `detached` would open a
    // console, and the tree-kill needs no group.
    ...(IS_WINDOWS ? { windowsHide: true } : { detached: true }),
    ...(options.windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
  }) as ChildProcessWithoutNullStreams;
  if (options.fd3Input !== undefined) {
    const fd3 = child.stdio[3] as Writable | null | undefined;
    // A child that exits before reading closes the pipe: EPIPE, ignored.
    fd3?.on("error", () => undefined);
    fd3?.end(options.fd3Input);
  }
  return child;
}
