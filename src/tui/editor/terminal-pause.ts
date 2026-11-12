/**
 * Hand the terminal to a foreground child (the external editor, ATO-655)
 * and take it back.
 *
 * The TUI holds the terminal in several modes at once, and each one
 * breaks an editor differently if left on:
 *
 *   - raw mode: the editor expects to set the line discipline itself and
 *     restores what it found, so it must find cooked mode;
 *   - mouse reporting: clicks would arrive in vim or nano as escape
 *     sequences typed into the file;
 *   - the alternate screen: the editor enters its own, and its exit
 *     (`?1049l`) would drop us onto the main screen mid-session;
 *   - the kitty keyboard protocol: keys would arrive CSI-u encoded to an
 *     editor that never asked for that.
 *
 * `resume()` puts every mode back and clears the screen. Ink still
 * believes its last frame is on screen, so the caller has to change
 * something on screen (the composer text, a notice) to get a full frame
 * painted over the cleared one.
 */
import type { MouseTrackingController } from "../mouse/mouse-tracking.js";
import type { TerminalHandover } from "./external-editor.js";

const ENTER_ALT_SCREEN = "\u001B[?1049h";
const LEAVE_ALT_SCREEN = "\u001B[?1049l";
const ENABLE_ALT_SCROLL = "\u001B[?1007h";
const DISABLE_ALT_SCROLL = "\u001B[?1007l";
const SHOW_CURSOR = "\u001B[?25h";
const HIDE_CURSOR = "\u001B[?25l";
const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";
/** Push the flags Ink enables (`disambiguateEscapeCodes` = 1). */
const KITTY_PUSH = "\u001B[>1u";
const KITTY_POP = "\u001B[<u";

export interface PausableStdin {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface PausableStdout {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface TerminalPauseOptions {
  readonly stdin: PausableStdin;
  readonly stdout: PausableStdout;
  /** Whether Ink was started with the kitty keyboard protocol on. */
  readonly kittyKeyboard: boolean;
  /** The live mouse controller, `null` while reporting is off. */
  readonly mouse: () => MouseTrackingController | null;
}

export function createTerminalPause(
  options: TerminalPauseOptions,
): TerminalHandover {
  const { stdin, stdout, kittyKeyboard } = options;
  // What suspend() changed, so resume() undoes exactly that: a mouse the
  // selection passthrough had already paused stays paused for it to
  // resume on its own timer, and raw mode is re-entered only if it was on.
  let pausedMouse: MouseTrackingController | null = null;
  let restoreRaw = false;
  return {
    suspend: () => {
      const mouse = options.mouse();
      pausedMouse = mouse && !mouse.isSuspended() ? mouse : null;
      pausedMouse?.suspend();
      if (stdout.isTTY === true) {
        stdout.write(
          (kittyKeyboard ? KITTY_POP : "") +
            SHOW_CURSOR +
            DISABLE_ALT_SCROLL +
            LEAVE_ALT_SCREEN,
        );
      }
      restoreRaw = stdin.isTTY === true && stdin.isRaw === true;
      if (restoreRaw) stdin.setRawMode?.(false);
    },
    resume: () => {
      if (restoreRaw) stdin.setRawMode?.(true);
      restoreRaw = false;
      if (stdout.isTTY === true) {
        stdout.write(
          ENTER_ALT_SCREEN +
            ENABLE_ALT_SCROLL +
            CLEAR_SCREEN_AND_HOME +
            HIDE_CURSOR +
            (kittyKeyboard ? KITTY_PUSH : ""),
        );
      }
      pausedMouse?.resume();
      pausedMouse = null;
    },
  };
}
