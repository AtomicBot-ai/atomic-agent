/**
 * Alternate screen buffer manager. Wraps the xterm escape sequences used
 * by `vim`, `less`, `htop` and friends so the TUI gets its own scroll
 * buffer and the host terminal scrollback is preserved untouched.
 *
 * Only emits sequences when the target stream is a TTY; in pipes/CI the
 * helpers become no-ops. Installation is idempotent and paired with a
 * `process.on('exit')` hook so the alt screen is always left even if an
 * uncaught exception or signal terminates the process.
 */
import type { Writable } from "node:stream";

const ENTER_ALT_SCREEN = "\u001B[?1049h";
const LEAVE_ALT_SCREEN = "\u001B[?1049l";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

export interface AltScreenController {
  /** Releases the alt screen and restores the cursor. Safe to call twice. */
  restore(): void;
}

export interface AltScreenOptions {
  readonly stdout?: NodeJS.WriteStream;
  /** If true, also toggles the cursor while the alt screen is active. */
  readonly hideCursor?: boolean;
}

/**
 * Switches `stdout` into the alternate screen buffer and returns a
 * controller whose `restore()` undoes the switch. If the stream is not a
 * TTY (piped output, CI) the helpers are silent no-ops so automated
 * harnesses continue to see the final frame on stdout.
 */
export function enterAltScreen(options: AltScreenOptions = {}): AltScreenController {
  const stdout = options.stdout ?? process.stdout;
  const hideCursor = options.hideCursor ?? true;
  if (!streamIsTty(stdout)) {
    return { restore: () => {} };
  }
  stdout.write(ENTER_ALT_SCREEN);
  if (hideCursor) stdout.write(HIDE_CURSOR);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (hideCursor) stdout.write(SHOW_CURSOR);
    stdout.write(LEAVE_ALT_SCREEN);
  };
  // Last-chance cleanup if the process dies without a clean teardown —
  // missing this handler is how TUIs leave terminals in a broken state.
  const onExit = (): void => restore();
  process.once("exit", onExit);
  return {
    restore: () => {
      process.off("exit", onExit);
      restore();
    },
  };
}

function streamIsTty(stream: Writable): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}
