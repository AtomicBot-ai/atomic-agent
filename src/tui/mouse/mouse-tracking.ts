/**
 * Mouse reporting mode manager — the terminal-side half of TUI mouse
 * support. Deliberately shaped like `alt-screen.ts`: an
 * `enable → controller.disable()` pair, silent on non-TTY streams, and
 * a place in the shared `terminal-restore.ts` net so a crash never
 * leaves the host terminal in reporting mode (where every click would
 * print garbage into the user's shell). The net registers mouse
 * reporting *after* the alt screen and unwinds LIFO, so reporting stops
 * first and the terminal is never briefly on the normal screen while
 * still reporting clicks.
 *
 * Between enable and disable the controller can also `suspend()` /
 * `resume()` — the same escape sequences, but the controller stays
 * alive and stays in the restore net. This is what the Shift+drag
 * selection window (`selection-passthrough.ts`) rides on: reporting is
 * handed back to the terminal for a few seconds without tearing the
 * mouse layer down.
 *
 * We request **1002 (button-event tracking)** plus **1006 (SGR
 * encoding)**. 1002 is 1000 plus motion reports *while a button is
 * held*, which is what makes drag-to-select in the composer possible;
 * the parser decodes the motion bit into its own event kind so a drag
 * cannot be mistaken for a click per cell it crosses.
 *
 * **1003 (any-motion) stays off.** It reports every pointer movement
 * whether or not a button is down — a constant stream of wakeups, and
 * the hit-test walks the Yoga tree for every registered target on each
 * event. Nothing in this UI hovers, so there is nothing to spend it on.
 *
 * The trade-off this mode forces — the terminal stops doing its own
 * drag-to-select while reporting is on — is why mouse support is a
 * toggle (`tui.mouse`, `--no-mouse`, `/mouse`) rather than a
 * hard-wired behaviour. `disable()` restores native selection
 * instantly, without restarting the TUI.
 */
import type { Writable } from "node:stream";

import { registerTerminalRestore } from "../terminal-restore.js";

/** Button-event tracking: press, release, and motion while held. */
const ENABLE_BUTTON_TRACKING = "\u001B[?1002h";
const DISABLE_BUTTON_TRACKING = "\u001B[?1002l";
/** SGR extended reports — required past column 223. */
const ENABLE_SGR_REPORTS = "\u001B[?1006h";
const DISABLE_SGR_REPORTS = "\u001B[?1006l";

export interface MouseTrackingController {
  /** Stops mouse reporting and hands selection back to the terminal. Safe to call twice. */
  disable(): void;
  /**
   * Pauses reporting without giving the controller up: the disable
   * sequences go out, but the restore-net registration and the
   * controller itself stay live so `resume()` can bring reporting
   * back. Idempotent; a no-op after `disable()`.
   */
  suspend(): void;
  /** Undoes `suspend()`. Idempotent; a no-op after `disable()`. */
  resume(): void;
  /** True between `suspend()` and `resume()`; false after `disable()`. */
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
  const writeEnable = (): void => {
    stdout.write(ENABLE_BUTTON_TRACKING);
    stdout.write(ENABLE_SGR_REPORTS);
  };
  const writeDisable = (): void => {
    // Reverse order: stop the extended encoding first so a terminal
    // that only understood 1000 still sees a clean disable.
    stdout.write(DISABLE_SGR_REPORTS);
    stdout.write(DISABLE_BUTTON_TRACKING);
  };
  writeEnable();
  let disabled = false;
  let suspended = false;
  const disable = (): void => {
    if (disabled) return;
    disabled = true;
    // A suspended controller already sent the disable pair; the terminal
    // is clean and a second copy would be noise on the wire.
    if (!suspended) writeDisable();
    suspended = false;
  };
  // Last-chance cleanup. Without it an uncaught exception leaves the
  // terminal reporting clicks as escape sequences into the shell.
  const unregister = registerTerminalRestore(disable);
  return {
    disable: () => {
      unregister();
      disable();
    },
    suspend: () => {
      if (disabled || suspended) return;
      suspended = true;
      writeDisable();
    },
    resume: () => {
      if (disabled || !suspended) return;
      suspended = false;
      writeEnable();
    },
    isSuspended: () => suspended,
  };
}

function streamIsTty(stream: Writable): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}
