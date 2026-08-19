/**
 * Mouse reporting mode manager — the terminal-side half of TUI mouse
 * support. Deliberately shaped like `alt-screen.ts`: a single
 * `enable → controller.disable()` pair, silent on non-TTY streams, and
 * a `process.on("exit")` safety net so a crash never leaves the host
 * terminal in reporting mode (where every click would print garbage
 * into the user's shell).
 *
 * We request **1000 (normal tracking)** plus **1006 (SGR encoding)**
 * only. 1002/1003 (drag / any-motion) are intentionally left off: the
 * app has no hover or drag affordance, and motion reports are a
 * constant stream of wakeups for a UI that does not use them.
 *
 * The trade-off this mode forces — the terminal stops doing its own
 * drag-to-select while reporting is on — is why mouse support is a
 * toggle (`tui.mouse`, `--no-mouse`, `/mouse`) rather than a
 * hard-wired behaviour. `disable()` restores native selection
 * instantly, without restarting the TUI.
 *
 * `suspend()` / `resume()` are the *momentary* form of the same
 * trade-off, for the case where the operator wants one selection rather
 * than a mode change (see `selection-passthrough.ts`). They write the
 * same escape pairs `disable()` does, but keep the controller — and
 * critically its `process.on("exit")` restore — alive across the gap, so
 * a crash mid-selection still leaves a clean terminal. A `disable()`
 * while suspended writes nothing further and simply detaches the hook:
 * reporting is already off, and repeating the disable pair would be a
 * second `1000l` against a terminal that never saw a matching `1000h`.
 */
import type { Writable } from "node:stream";

/** Normal tracking: press + release, no motion. */
const ENABLE_BUTTON_TRACKING = "\u001B[?1000h";
const DISABLE_BUTTON_TRACKING = "\u001B[?1000l";
/** SGR extended reports — required past column 223. */
const ENABLE_SGR_REPORTS = "\u001B[?1006h";
const DISABLE_SGR_REPORTS = "\u001B[?1006l";

export interface MouseTrackingController {
  /** Stops mouse reporting and hands selection back to the terminal. Safe to call twice. */
  disable(): void;
  /**
   * Hands selection back *temporarily*. The controller stays live and
   * still cleans up on exit. Safe to call twice; a no-op once disabled.
   */
  suspend(): void;
  /** Re-requests reporting after a {@link suspend}. A no-op once disabled. */
  resume(): void;
  /** `true` between a {@link suspend} and its {@link resume}. */
  isSuspended(): boolean;
}

export interface MouseTrackingOptions {
  readonly stdout?: NodeJS.WriteStream;
}

/**
 * Turns on mouse reporting for `stdout` and returns a controller whose
 * `disable()` turns it back off. On a non-TTY stream (pipes, CI, the
 * test harness) both halves are no-ops, exactly like `enterAltScreen`.
 */
export function enableMouseTracking(
  options: MouseTrackingOptions = {},
): MouseTrackingController {
  const stdout = options.stdout ?? process.stdout;
  if (!streamIsTty(stdout)) {
    return {
      disable: () => {},
      suspend: () => {},
      resume: () => {},
      isSuspended: () => false,
    };
  }
  const startReporting = (): void => {
    stdout.write(ENABLE_BUTTON_TRACKING);
    stdout.write(ENABLE_SGR_REPORTS);
  };
  const stopReporting = (): void => {
    // Reverse order: stop the extended encoding first so a terminal
    // that only understood 1000 still sees a clean disable.
    stdout.write(DISABLE_SGR_REPORTS);
    stdout.write(DISABLE_BUTTON_TRACKING);
  };
  startReporting();
  let disabled = false;
  let suspended = false;
  const disable = (): void => {
    if (disabled) return;
    disabled = true;
    // Already handed back by `suspend()` — writing the pair again would
    // disable modes that are not currently on.
    if (suspended) return;
    stopReporting();
  };
  // Last-chance cleanup. Without it an uncaught exception leaves the
  // terminal reporting clicks as escape sequences into the shell.
  const onExit = (): void => disable();
  process.once("exit", onExit);
  return {
    disable: () => {
      process.off("exit", onExit);
      disable();
    },
    suspend: () => {
      if (disabled || suspended) return;
      suspended = true;
      stopReporting();
    },
    resume: () => {
      if (disabled || !suspended) return;
      suspended = false;
      startReporting();
    },
    isSuspended: () => suspended,
  };
}

function streamIsTty(stream: Writable): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}
