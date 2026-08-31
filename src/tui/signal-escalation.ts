/**
 * Two-stage signal handling for the TUI.
 *
 * The first SIGINT/SIGTERM/SIGHUP asks the orchestrator for a graceful
 * quit — Ink unmounts, the runtime shuts down, the `finally` block in
 * `tui-command.ts` hands the terminal back. With `process.once` that was
 * also the *only* covered signal: a second one fell through to Node's
 * default handler, which kills the process without firing `exit`, so a
 * wedged shutdown Ctrl-C'd (or `kill`ed) twice left the terminal in
 * mouse-reporting mode — every click at the shell prompt printing
 * `[<0;64;21M` — and on the alternate screen. Over ssh, where a hang is
 * exactly when people reach for a second signal, this was the reported
 * failure mode.
 *
 * So the second signal escalates instead of asking again: restore every
 * registered terminal mode (`terminal-restore.ts`) and exit hard. 130 is
 * the shell convention for "killed by SIGINT"; precise per-signal codes
 * matter less than leaving a terminal that echoes keystrokes.
 */

export interface SignalEscalationOptions {
  /** Graceful path: ask the app to unmount and shut down. */
  readonly quit: () => void;
  /** Hard path: undo mouse reporting, alt screen, and friends now. */
  readonly restoreTerminal: () => void;
  /** Ends the process; injected so tests can observe instead of dying. */
  readonly exit: (code: number) => void;
}

/**
 * Returns a handler to register for each fatal signal. First invocation
 * (whichever signal carries it) quits gracefully; any invocation after
 * that restores the terminal and exits 130.
 */
export function makeEscalatingSignalHandler(
  options: SignalEscalationOptions,
): () => void {
  let quitRequested = false;
  return () => {
    if (!quitRequested) {
      quitRequested = true;
      options.quit();
      return;
    }
    options.restoreTerminal();
    options.exit(130);
  };
}
