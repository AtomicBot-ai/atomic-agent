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

export interface SignalQuitOptions {
  /** Stops the work in flight: the orchestrator's `quit()`. */
  readonly stopWork: () => void;
  /** Tells the app it is quitting, so it shows that state (`quit_requested`). */
  readonly announce: () => void;
}

export interface SignalQuit {
  /** The graceful path for {@link makeEscalatingSignalHandler}. */
  readonly quit: () => void;
  /** Hands over the rendered Ink app; a quit that came first unmounts it now. */
  readonly attach: (ink: { unmount(): void }) => void;
}

/**
 * The graceful quit a signal asks for (ATO-1614).
 *
 * `orchestrator.quit()` alone only aborts the turn and clears the queue.
 * What ends the TUI is Ink unmounting: that resolves `waitUntilExit()`,
 * and the `finally` after it restores the terminal and shuts the runtime
 * down. The keyboard and `/quit` paths get there through the reducer's
 * `quit_requested`, which makes `TuiApp` call `app.exit()`. The signal
 * path never dispatched it, so the first SIGTERM stopped the work and
 * then the process sat on the alternate screen until a second signal or
 * a SIGKILL (the real-terminal CI test waited 30 s for an exit that never
 * came). So the signal quit also unmounts Ink itself: the bus drops
 * actions while the app has not subscribed yet, and a signal can land
 * before the first render, in which case the unmount happens on
 * {@link SignalQuit.attach}.
 */
export function makeSignalQuit(options: SignalQuitOptions): SignalQuit {
  let ink: { unmount(): void } | undefined;
  let requested = false;
  return {
    quit: () => {
      requested = true;
      options.stopWork();
      if (!ink) return;
      options.announce();
      ink.unmount();
    },
    attach: (rendered) => {
      ink = rendered;
      if (requested) rendered.unmount();
    },
  };
}
