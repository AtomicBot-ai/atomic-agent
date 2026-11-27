import { existsSync } from "node:fs";

import { quotePosixArg } from "./shell-interpretation.js";

/**
 * A pseudo-terminal for an interactive `os.shell.run` job (ATO-2277,
 * `tty: true`), without a native module: the system `script(1)` runs
 * the command on a pty and relays the job's stdin pipe to it. A REPL,
 * an installer's question or `npm init` then behave as at a terminal
 * (`isatty` is true, prompts are printed, input is echoed).
 *
 * - macOS (BSD script): `script -q /dev/null <program> <args…>`, behind
 *   a `cat` relay (see DARWIN_PIPE_RELAY).
 * - Linux (util-linux script): `script -q -f -e -c '<line>' /dev/null`;
 *   `-e` passes the command's exit code, `-f` flushes as it goes.
 * - Windows, or no `script` on the machine: plain pipes; stdin still
 *   takes input, but the program sees no terminal, and the result says
 *   so. A native ConPTY / node-pty backend is a follow-up.
 */

export interface TtySpawn {
  command: string;
  args: string[];
  /** A real pseudo-terminal; `false` = pipes only. */
  tty: boolean;
}

/** Where each system keeps `script`. */
const SCRIPT_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/usr/bin/script",
  linux: "/usr/bin/script",
};

/**
 * BSD `script` exits at once with "tcgetattr/ioctl: Operation not
 * supported on socket" when its stdin is a socket, and Node's stdio
 * pipes are socketpairs. So `/bin/sh` puts a real pipe in between: `cat`
 * copies the job's stdin into it, `script` reads the pipe. `$0` is the
 * script path and `"$@"` the program with its args. When `script`
 * exits, the relay `cat` is stopped and the program's exit code is
 * passed on. `cat` sees end of input when the job's stdin closes, so
 * `eof` still reaches the program. The program stays a descendant of
 * the job, so a stop or kill still reaches it through the descendant
 * walk (process-descendants.ts).
 */
const DARWIN_PIPE_RELAY =
  'cat 2>/dev/null | { "$0" -q /dev/null "$@"; s=$?; pkill -P $$ -x cat 2>/dev/null; exit $s; }';

export function wrapForTty(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): TtySpawn {
  const script = SCRIPT_PATHS[platform];
  if (script === undefined || !exists(script)) {
    return { command, args: [...args], tty: false };
  }
  if (platform === "darwin") {
    return { command: "/bin/sh", args: ["-c", DARWIN_PIPE_RELAY, script, command, ...args], tty: true };
  }
  const line = [command, ...args].map(quotePosixArg).join(" ");
  return { command: script, args: ["-q", "-f", "-e", "-c", line, "/dev/null"], tty: true };
}

/**
 * Environment for a pty job: a plain terminal type so programs print
 * few escape codes into the output the model reads.
 */
export function ttyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TERM: "dumb", NO_COLOR: "1" };
}
