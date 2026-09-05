import type { MouseButton, TuiMouseEvent } from "./mouse-event.js";

/**
 * Incremental decoder for xterm mouse reports.
 *
 * Three encodings are understood:
 *
 *   - **SGR / 1006** — `ESC [ < b ; col ; row (M|m)`. What we ask for
 *     (`\u001B[?1006h`) and what every modern terminal answers with.
 *     `M` is a press, `m` a release; columns/rows are 1-based and
 *     unbounded, which is why 1006 exists at all (the legacy encoding
 *     tops out at column 223).
 *   - **X10 / legacy** — `ESC [ M b col row` with each field a single
 *     byte offset by 32. Terminals that ignore the 1006 request fall
 *     back to this; decoding it costs ten lines and stops the raw bytes
 *     from being typed into the chat buffer as mojibake. The 1005
 *     (UTF-8 extended) variant shares the prefix and the +32 offset —
 *     stdin is decoded from UTF-8 before it reaches here, so its
 *     multi-byte coordinates arrive as single characters and land in
 *     the same branch.
 *   - **urxvt / 1015** — `ESC [ b ; col ; row M` with a decimal
 *     button-plus-32 and 1-based decimal coordinates. Nothing we
 *     request should elicit it, but a terminal (or ssh hop) confused
 *     enough to answer 1002 with it used to spray `32;45;12M` into the
 *     composer as text. Consuming it is cheap, and the shape — three
 *     decimal params, a `+32` button code, final uppercase `M` —
 *     collides with no keyboard sequence a terminal sends.
 *
 * The decoder is a pure function so the interesting part — a chunk
 * boundary splitting a report in half — is unit-testable without a
 * terminal. Everything that is not a mouse report comes back verbatim
 * in `text` and must reach Ink's key parser untouched.
 */

const ESC = "\u001B";
/** Bit 2 of the button byte. */
const SHIFT_BIT = 4;
/** Bit 3 ("meta" in the spec, Alt/Option in practice). */
const ALT_BIT = 8;
/** Bit 4. */
const CTRL_BIT = 16;
/**
 * Bit 5 — set on reports the terminal sends while a button is held
 * (DECSET 1002 button-event tracking). Without decoding it, a drag
 * report is indistinguishable from a fresh press.
 */
const MOTION_BIT = 32;
/** Bit 6 — wheel reports arrive as buttons 64 (up) / 65 (down). */
const WHEEL_BIT = 64;

const SGR_MOUSE = /^\u001B\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])/;
const URXVT_MOUSE = /^\u001B\[(\d{1,3});(\d{1,4});(\d{1,4})M/;
const TRUNCATED_SGR = /^\u001B\[<\d{0,6}(;\d{0,6}){0,2}$/;
const TRUNCATED_X10 = /^\u001B\[M[\s\S]{0,2}$/;
/**
 * A CSI head that could still become a 1015 report. Deliberately also
 * covers truncated keyboard CSIs (`ESC [ 1 ; 5` waiting for its `C`):
 * buffering those until the final byte arrives hands Ink a whole
 * sequence instead of a split it would mis-parse, and a real terminal
 * always sends the rest of the sequence in the next read.
 */
const TRUNCATED_URXVT = /^\u001B\[\d{0,3}(;\d{0,4}){0,2}$/;
/** 1015 button codes are the X10 button byte as a decimal — 32 is the floor. */
const URXVT_CODE_OFFSET = 32;

export interface DecodedMouseChunk {
  /** Mouse reports found in this chunk, in arrival order. */
  readonly events: TuiMouseEvent[];
  /** Everything that was not a mouse report — forward this to Ink. */
  readonly text: string;
  /**
   * Trailing bytes that *might* be the head of a mouse report split
   * across a read boundary. Prepend to the next chunk.
   */
  readonly rest: string;
}

/**
 * Split `buffer` into mouse events plus the keyboard bytes around them.
 *
 * A lone trailing `ESC` is deliberately **not** buffered: that is how
 * the Escape key itself arrives, and holding it back would make Esc
 * respond only after the next keystroke. An incomplete `ESC [` (or a
 * truncated report) is buffered — neither is a complete key sequence
 * Ink could act on anyway.
 */
export function decodeMouseEvents(buffer: string): DecodedMouseChunk {
  const events: TuiMouseEvent[] = [];
  let text = "";
  let index = 0;
  while (index < buffer.length) {
    const esc = buffer.indexOf(ESC, index);
    if (esc === -1) {
      text += buffer.slice(index);
      return { events, text, rest: "" };
    }
    text += buffer.slice(index, esc);
    const tail = buffer.slice(esc);
    // Lone ESC at the very end, or an ESC followed by something that is
    // not a CSI introducer: not ours, pass it through.
    if (tail.length === 1 || tail[1] !== "[") {
      text += ESC;
      index = esc + 1;
      continue;
    }
    const sgr = SGR_MOUSE.exec(tail);
    if (sgr) {
      events.push(decodeSgr(sgr));
      index = esc + sgr[0].length;
      continue;
    }
    if (tail.startsWith(`${ESC}[M`)) {
      if (tail.length < 6) return { events, text, rest: tail };
      events.push(decodeX10(tail));
      index = esc + 6;
      continue;
    }
    const urxvt = URXVT_MOUSE.exec(tail);
    // The button-code floor keeps this branch honest: a three-param CSI
    // ending in `M` whose first parameter could not be a 1015 button
    // code is not a mouse report and belongs to Ink.
    if (urxvt && Number.parseInt(urxvt[1] ?? "0", 10) >= URXVT_CODE_OFFSET) {
      events.push(decodeUrxvt(urxvt));
      index = esc + urxvt[0].length;
      continue;
    }
    if (
      tail === `${ESC}[` ||
      TRUNCATED_SGR.test(tail) ||
      TRUNCATED_X10.test(tail) ||
      TRUNCATED_URXVT.test(tail)
    ) {
      return { events, text, rest: tail };
    }
    // A CSI that is not a mouse report (arrows, Shift+Tab, kitty
    // protocol replies…). Emit the introducer and resume scanning after
    // it so the rest of the sequence flows to Ink unchanged.
    text += `${ESC}[`;
    index = esc + 2;
  }
  return { events, text, rest: "" };
}

function decodeSgr(match: RegExpExecArray): TuiMouseEvent {
  const code = Number.parseInt(match[1] ?? "0", 10);
  const column = Number.parseInt(match[2] ?? "1", 10);
  const row = Number.parseInt(match[3] ?? "1", 10);
  return buildEvent(code, column, row, match[4] === "m");
}

function decodeX10(tail: string): TuiMouseEvent {
  const code = (tail.codePointAt(3) ?? 32) - 32;
  const column = (tail.codePointAt(4) ?? 33) - 32;
  const row = (tail.codePointAt(5) ?? 33) - 32;
  // The legacy encoding has no dedicated release code: low bits `3`
  // mean "some button came up" and never say which one.
  return buildEvent(code, column, row, (code & 3) === 3);
}

function decodeUrxvt(match: RegExpExecArray): TuiMouseEvent {
  // Same button byte as X10, transported as a decimal; coordinates are
  // plain 1-based decimals with no offset.
  const code = Number.parseInt(match[1] ?? "32", 10) - URXVT_CODE_OFFSET;
  const column = Number.parseInt(match[2] ?? "1", 10);
  const row = Number.parseInt(match[3] ?? "1", 10);
  return buildEvent(code, column, row, (code & 3) === 3);
}

function buildEvent(
  code: number,
  column: number,
  row: number,
  released: boolean,
): TuiMouseEvent {
  const wheeling = (code & WHEEL_BIT) !== 0;
  const dragging = !wheeling && !released && (code & MOTION_BIT) !== 0;
  const low = code & 3;
  return {
    kind: wheeling
      ? "wheel"
      : released
        ? "release"
        : dragging
          ? "motion"
          : "press",
    // A motion report still names the button being held, which is what
    // lets a drag be attributed to the gesture that started it.
    button: wheeling || released ? "none" : buttonFromLowBits(low),
    wheel: wheeling ? (low === 0 ? "up" : "down") : null,
    // Terminals report 1-based cells; the layout engine is 0-based.
    x: Math.max(0, column - 1),
    y: Math.max(0, row - 1),
    shift: (code & SHIFT_BIT) !== 0,
    alt: (code & ALT_BIT) !== 0,
    ctrl: (code & CTRL_BIT) !== 0,
  };
}

function buttonFromLowBits(low: number): MouseButton {
  if (low === 0) return "left";
  if (low === 1) return "middle";
  if (low === 2) return "right";
  return "none";
}
