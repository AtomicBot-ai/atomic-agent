/**
 * Keyboard/mouse demultiplexer for the TUI's stdin.
 *
 * Ink parses stdin as keystrokes and has no mouse layer, so a raw mouse
 * report reaching it is decoded as a stray Escape plus a handful of
 * literal characters typed into the chat buffer. Rather than fight that
 * downstream, we hand Ink a *different* stream: this module reads the
 * real TTY, pulls the mouse reports out, and forwards everything else
 * to a `PassThrough` that Ink treats as its stdin.
 *
 * The wrapper has to look enough like `process.stdin` for Ink's raw
 * mode plumbing — `isTTY`, `setRawMode`, `ref`/`unref` — so those are
 * delegated to the real stream. Ink also `unshift()`s bytes back during
 * its kitty-keyboard probe; a `PassThrough` supports that natively.
 *
 * Two ssh-hardening layers live here rather than in the pure decoder:
 *
 *   - **The ESC-split hold.** An ssh hop re-chunks the byte stream, so
 *     during a wheel or drag flood some read eventually ends exactly on
 *     a report's ESC. The decoder forwards a chunk-final lone ESC as
 *     text (that is how the Escape key arrives), which used to type the
 *     rest of the report — `[<64;3;9M` — straight into the composer. So
 *     a chunk-final ESC is held for {@link ESC_SPLIT_FLUSH_MS} before
 *     being forwarded: if the rest of a report follows, they rejoin and
 *     decode; if nothing follows, it was the Escape key and flushes.
 *     Ink defers a lone Esc ~20ms itself, so the hold is imperceptible.
 *   - **The leak breaker.** If, despite the decoder, mouse-report-shaped
 *     text is about to reach Ink (an encoding or a mangling nobody
 *     anticipated), the shapes are stripped and `onMouseTextLeak` fires
 *     once so the caller can turn mouse tracking off for the session
 *     instead of letting the terminal spray coordinates into the chat.
 */
import { PassThrough } from "node:stream";
import { decodeMouseEvents } from "./parse-mouse-events.js";
import type { TuiMouseEvent } from "./mouse-event.js";

const ESC = "\u001B";

/**
 * How long a chunk-final lone ESC waits for the rest of a split mouse
 * report. Consecutive ssh channel packets arrive well under a
 * millisecond apart; the Escape key pays this once, on top of Ink's own
 * ~20ms lone-Esc deferral.
 */
export const ESC_SPLIT_FLUSH_MS = 10;

/**
 * Mouse-report remnants as they look after losing their ESC: an SGR
 * body (either case) or a urxvt body (uppercase `M` only — lowercase
 * would match the SGR color codes in any pasted shell output).
 */
const REPORT_REMNANT =
  /\[(?:<\d{1,4};\d{1,4};\d{1,4}[Mm]|\d{1,4};\d{1,4};\d{1,4}M)/g;

/**
 * A proper prefix of {@link REPORT_REMNANT} at the end of a chunk — the
 * head of a remnant the next read may complete.
 */
const REPORT_REMNANT_PREFIX = /\[<?(?:\d{1,4}(?:;\d{0,4}){0,2})?$/;

/**
 * Remnants in a single chunk before the breaker trips. One shape alone
 * could be a paste that happens to contain it; a terminal misreporting
 * the mouse produces bursts.
 */
const LEAK_TRIP_COUNT = 2;
/**
 * Remnants across the whole session before the breaker trips anyway. A
 * lossy link can stall mid-report for longer than the ESC-split hold,
 * leaking one report per stall — never two in a chunk, but not a paste
 * either by the third time.
 */
const LEAK_TRIP_TOTAL = 3;

export interface MouseStdin {
  /** Stream to hand to Ink's `render({ stdin })` — mouse bytes removed. */
  readonly stdin: NodeJS.ReadStream;
  /** Detaches from the real stdin. Call during TUI teardown. */
  dispose(): void;
}

export interface MouseStdinOptions {
  /**
   * Whether mouse reporting is currently requested. The leak breaker
   * only arms itself while this returns true — report-shaped text on a
   * terminal that was never asked to report is a paste, not a leak.
   * Defaults to armed when `onMouseTextLeak` is provided.
   */
  readonly mouseActive?: () => boolean;
  /**
   * Fires once per session, when mouse-report-shaped text was about to
   * reach Ink as keystrokes. From then on such shapes are stripped from
   * the forwarded stream; the caller should disable mouse tracking and
   * tell the operator.
   */
  readonly onMouseTextLeak?: () => void;
}

/**
 * Wraps `source` so mouse reports are delivered to `onMouseEvent` and
 * every other byte flows through to the returned stream.
 */
export function createMouseStdin(
  source: NodeJS.ReadStream,
  onMouseEvent: (event: TuiMouseEvent) => void,
  options: MouseStdinOptions = {},
): MouseStdin {
  const passthrough = new PassThrough();
  // Ink asks its stdin for raw mode and for TTY-ness; both questions
  // are really about the underlying terminal, so proxy them.
  const proxy = passthrough as unknown as NodeJS.ReadStream;
  Object.defineProperty(proxy, "isTTY", {
    configurable: true,
    get: () => source.isTTY,
  });
  Object.defineProperty(proxy, "isRaw", {
    configurable: true,
    get: () => source.isRaw,
  });
  proxy.setRawMode = (mode: boolean): NodeJS.ReadStream => {
    source.setRawMode?.(mode);
    return proxy;
  };
  // `ref`/`unref` are TTY/socket concerns — a PassThrough has neither,
  // so they belong to the real stdin and only to it.
  proxy.ref = (): NodeJS.ReadStream => {
    source.ref?.();
    return proxy;
  };
  proxy.unref = (): NodeJS.ReadStream => {
    source.unref?.();
    return proxy;
  };

  // Once tripped, stays tripped: the terminal has proven it garbles
  // mouse reports, and a few in-flight chunks keep arriving even after
  // the caller writes the disable sequence.
  let leakTripped = false;
  let remnantsSeen = 0;
  // A remnant can itself be split across reads (the same re-chunking
  // that leaked it), so counting scans the tail of what was already
  // forwarded joined to the new text — one character short of the
  // longest remnant is enough to complete any spanning match.
  let scanTail = "";
  const SCAN_TAIL_LENGTH = 16;
  const countFreshRemnants = (text: string): number => {
    const joined = scanTail + text;
    let fresh = 0;
    REPORT_REMNANT.lastIndex = 0;
    for (const match of joined.matchAll(REPORT_REMNANT)) {
      // Matches ending inside the tail were counted on an earlier read.
      if (match.index + match[0].length > scanTail.length) fresh += 1;
    }
    scanTail = joined.slice(-SCAN_TAIL_LENGTH);
    return fresh;
  };
  // Stripping needs the same cross-read joining as counting — the ssh
  // re-chunking that garbles reports keeps doing it to the in-flight
  // stragglers — but unlike the counter it must keep the bytes out of
  // Ink, so instead of scanning an already-forwarded tail it withholds
  // a chunk-final remnant prefix until the rest arrives (stragglers
  // trail each other by well under a millisecond) or a brief timer
  // rules it ordinary typing, mirroring the ESC-split hold.
  let stripHold = "";
  let stripTimer: NodeJS.Timeout | null = null;
  const flushStripHold = (): void => {
    stripTimer = null;
    if (stripHold.length === 0) return;
    const held = stripHold;
    stripHold = "";
    passthrough.write(held);
  };
  const stripRemnants = (text: string): string => {
    if (stripTimer) {
      clearTimeout(stripTimer);
      stripTimer = null;
    }
    let out = (stripHold + text).replace(REPORT_REMNANT, "");
    stripHold = REPORT_REMNANT_PREFIX.exec(out)?.[0] ?? "";
    if (stripHold.length > 0) {
      out = out.slice(0, -stripHold.length);
      stripTimer = setTimeout(flushStripHold, ESC_SPLIT_FLUSH_MS);
      stripTimer.unref?.();
    }
    return out;
  };
  const forwardText = (text: string): void => {
    if (text.length === 0) return;
    let out = text;
    if (leakTripped) {
      out = stripRemnants(out);
    } else if (options.onMouseTextLeak && (options.mouseActive?.() ?? true)) {
      const fresh = countFreshRemnants(text);
      if (fresh > 0) {
        remnantsSeen += fresh;
        if (fresh >= LEAK_TRIP_COUNT || remnantsSeen >= LEAK_TRIP_TOTAL) {
          leakTripped = true;
          out = stripRemnants(out);
          options.onMouseTextLeak();
        }
      }
    }
    if (out.length > 0) passthrough.write(out);
  };

  // A report can straddle two reads; `pending` holds the head of a
  // truncated sequence until the rest of it arrives. `escHeld` is the
  // ESC-split hold described in the module doc — a chunk-final ESC kept
  // back briefly in case it is the start of a split report.
  let pending = "";
  let escHeld = false;
  let escTimer: NodeJS.Timeout | null = null;
  const flushHeldEsc = (): void => {
    escTimer = null;
    if (!escHeld) return;
    escHeld = false;
    forwardText(ESC);
  };
  const onData = (chunk: Buffer | string): void => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    let raw =
      pending +
      (escHeld ? ESC : "") +
      (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    escHeld = false;
    if (raw.endsWith(ESC)) {
      raw = raw.slice(0, -1);
      escHeld = true;
    }
    const decoded = decodeMouseEvents(raw);
    pending = decoded.rest;
    for (const event of decoded.events) onMouseEvent(event);
    forwardText(decoded.text);
    if (escHeld) {
      escTimer = setTimeout(flushHeldEsc, ESC_SPLIT_FLUSH_MS);
      escTimer.unref?.();
    }
  };
  source.on("data", onData);

  return {
    stdin: proxy,
    dispose: () => {
      source.off("data", onData);
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      if (stripTimer) {
        clearTimeout(stripTimer);
        stripTimer = null;
      }
      escHeld = false;
      pending = "";
      stripHold = "";
    },
  };
}
