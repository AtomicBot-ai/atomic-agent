/**
 * pseudo-terminal.mjs: run a program on a real pseudo-terminal from macOS
 * script(1). The repo has no PTY package and a dependency is not worth adding
 * for the two scenarios that drive the terminal app.
 *
 * script(1) asks its stdin for terminal settings and accepts only the answer
 * "not a terminal" (ENOTTY). A stdin that is a socket, which is what Node's
 * `stdio: 'pipe'` makes, or a FIFO, which macOS builds on sockets, answers
 * something else and script exits at once with
 * "tcgetattr/ioctl: Operation not supported on socket". A pipe made by a shell
 * answers correctly, so `cat` carries Node's stdin into one.
 *
 * When the program ends nothing tells that `cat` to stop, and the shell would
 * wait for it forever, so the right side of the pipeline ends it.
 *
 * The child's stdin is the keyboard and its stdout is the screen. The terminal
 * starts with no size: the program must run `stty rows N cols M` first.
 * `detached` makes the child a process group, so a scenario can signal all of it.
 */

import { spawn } from 'node:child_process';

export const SCRIPT_BIN = '/usr/bin/script';

const KEYBOARD_THROUGH_A_REAL_PIPE = 'cat | { "$0" -q /dev/null "$@"; code=$?; /usr/bin/pkill -P $$ -x cat; exit $code; }';

export function spawnOnPseudoTerminal(command, { cwd, env }) {
  return spawn('/bin/sh', ['-c', KEYBOARD_THROUGH_A_REAL_PIPE, SCRIPT_BIN, ...command],
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
