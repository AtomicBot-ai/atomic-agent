/**
 * `verify.run` starts a command without a terminal: no TTY on stdin or
 * stdout, and the environment of the app that launched the agent, which
 * may have no `TERM` (an app opened from the Finder). A curses or other
 * full-screen terminal program then fails in `setupterm` / `initscr`
 * before any of its logic runs, and an interactive one that does start
 * never exits on its own, so `exit 0` cannot pass either way.
 *
 * Seen live (ATO-323): the model kept re-running such a program and
 * spent its steps. When the output shows that failure, the result says
 * what it means and what to check instead.
 */

const TERMINAL_FAILURE =
  /setupterm|could not find terminal|_curses\.error|Error opening terminal|initscr|cbreak\(\) returned ERR|Inappropriate ioctl for device|not a tty|stdin is not a terminal|stdout is not a terminal/i;

export const TERMINAL_APP_HINT =
  "This looks like a full-screen terminal (curses/TUI) program. verify.run runs commands without a terminal, so such a program cannot be checked this way. " +
  "Check its logic instead: import the module and call its functions in a short script or a test, with the screen code kept out of the path.";

/** The hint, when the run's output shows a missing-terminal failure. */
export function terminalAppHint(stdout: string, stderr: string): string | undefined {
  return TERMINAL_FAILURE.test(stderr) || TERMINAL_FAILURE.test(stdout)
    ? TERMINAL_APP_HINT
    : undefined;
}
