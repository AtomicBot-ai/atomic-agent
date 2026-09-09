/**
 * Frame tearing, and the one escape sequence that ends it.
 *
 * Ink paints by writing a whole frame to stdout: cursor home, then every
 * line, then the trailing clear. On a terminal that renders as bytes
 * arrive, the moment between the first line and the last is a moment
 * where the screen holds half of the previous frame and half of the
 * next. Redraw often enough and that reads as the UI *shaking* — which
 * is the word the Windows 10 report used, and the right one.
 *
 * It is not equally visible everywhere. macOS terminals coalesce
 * aggressively enough to hide most of it; Windows Terminal and conhost
 * do not, which is how a cross-platform behaviour arrived as a Windows
 * bug report.
 *
 * DEC private mode 2026 — "synchronized output" — is the fix the
 * terminal side already implemented. `CSI ? 2026 h` tells the emulator
 * to hold what it renders until `CSI ? 2026 l`, so a frame appears whole
 * or not at all.
 *
 * **Why it is safe to send unconditionally.** An unrecognised DEC private
 * mode is ignored — that is what the "private" in the name buys, and it
 * is why terminals without 2026 have always received these bytes from
 * other TUIs without complaint. There is no probe here for the same
 * reason there is none in `alt-screen.ts`: asking costs a round trip on
 * a stdin something else is reading, and the fallback is exactly the
 * behaviour we have today.
 *
 * `ATOMIC_AGENT_NO_SYNC_OUTPUT=1` turns it off for anyone who finds a
 * terminal that mishandles it.
 */
import { registerTerminalRestore } from "./terminal-restore.js";

/** Begin Synchronized Update. */
const BSU = "\u001B[?2026h";
/** End Synchronized Update. */
const ESU = "\u001B[?2026l";

export interface SynchronizedOutputController {
  /** Puts the original `write` back. Safe to call twice. */
  restore(): void;
}

export interface SynchronizedOutputOptions {
  readonly stdout?: NodeJS.WriteStream;
  /** Env source for the opt-out; injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Erase-in-line: `CSI K`, `CSI 0 K`, `CSI 1 K`, `CSI 2 K`.
 *
 * The one sequence that only ever appears when something is repainting
 * text. Ink terminates every line it rewrites with `CSI K`, and its
 * whole-block clears use `CSI 2 K`; no mode toggle, cursor nudge or
 * mouse/kitty setup sequence contains either.
 */
const ERASE_IN_LINE = /\u001B\[[0-2]?K/;

/**
 * True when `chunk` is worth bracketing.
 *
 * Wrapping a lone escape sequence in a synchronized update is not wrong,
 * but it is two extra sequences spent rendering nothing — and this
 * `write` sees every cursor nudge and mode toggle the app makes, not
 * only Ink's frames. A full frame is many bytes and contains a newline;
 * a mode toggle is neither.
 *
 * Incremental rendering makes a third clause worth having, as a
 * backstop rather than as a fix for anything observed. A repaint that
 * rewrites one line of a fullscreen frame carries no newline — cursor
 * moves, the line, `CSI K` — so only its length keeps it bracketed, and
 * its length is incidental: one cursor-move per skipped row plus
 * whatever the changed line happens to contain.
 *
 * Measured, that length has never come close to the bar. Driving the
 * TUI over a PTY at 110x34, 80x24 and 40x16 — the last is the smallest
 * window the TUI will render in at all; below it the screen is
 * `terminal too small`, and no frame is written — the smallest chunk
 * this `write` bracketed was 189 bytes, and across every scenario
 * (startup, menus, submenus, the Manage tabs, both pickers, the update
 * modal, mouse drag and wheel, resizes in both dimensions, teardown)
 * not one chunk was caught by this clause that the length test had not
 * already caught. So it is insurance against a shape the app does not
 * currently produce, not a repair.
 *
 * It is close to free: `||` short-circuits, so the regex only ever runs
 * on chunks of 64 bytes or fewer with no newline in them — never on a
 * frame. And the predicate is the honest one: something that erases a
 * line is repainting, and a repaint that slips through unbracketed is
 * exactly the tearing this module exists to stop.
 */
export function looksLikeFrame(chunk: string): boolean {
  return (
    chunk.length > 64 || chunk.includes("\n") || ERASE_IN_LINE.test(chunk)
  );
}

/**
 * Bracket each frame Ink writes in a synchronized update.
 *
 * Implemented by replacing `stdout.write` rather than by handing Ink a
 * wrapper stream, because Ink reads `columns`, `rows` and the `resize`
 * event off that same object — a proxy would have to forward all of it
 * correctly, and getting that subtly wrong breaks resize handling in a
 * way much harder to spot than tearing. Patching one method on the real
 * stream leaves every other property where it was. `alt-screen.ts` and
 * `mouse-tracking.ts` already own the terminal this way.
 *
 * Non-TTY streams (pipes, CI, the test renderer) are left alone: there
 * is nothing to tear, and the markers would be noise in a captured log.
 */
export function enableSynchronizedOutput(
  options: SynchronizedOutputOptions = {},
): SynchronizedOutputController {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  if (!stdout.isTTY || env.ATOMIC_AGENT_NO_SYNC_OUTPUT === "1") {
    return { restore: () => {} };
  }
  const original = stdout.write.bind(stdout) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  let restored = false;

  const patched = ((
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    const rest = [encoding, callback].filter((arg) => arg !== undefined);
    if (typeof chunk === "string" && looksLikeFrame(chunk)) {
      // One `write`, not three. Three would put the stream's own
      // chunking between a marker and the frame it is meant to bracket,
      // which is the very thing this exists to prevent.
      return original(`${BSU}${chunk}${ESU}`, ...rest);
    }
    return original(chunk, ...rest);
  }) as NodeJS.WriteStream["write"];

  stdout.write = patched;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    // Only put it back if nothing else has patched over us since;
    // clobbering a later patch would be worse than leaving ours in.
    if (stdout.write === patched) {
      stdout.write = original as NodeJS.WriteStream["write"];
    }
    // A crash between BSU and ESU would leave the terminal holding its
    // display indefinitely. Cheap insurance, and inert where 2026 is not
    // implemented.
    original(ESU);
  };
  registerTerminalRestore(restore);
  return { restore };
}
