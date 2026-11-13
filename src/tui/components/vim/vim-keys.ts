import type { Key } from "ink";
import { enterNormal } from "./vim-insert.js";
import { normalKey } from "./vim-normal.js";
import {
  clearPending,
  hasPending,
  type VimBuffer,
  type VimState,
} from "./vim-types.js";

/**
 * Where an Ink keypress goes when vim mode is on (ATO-662). `handled:
 * false` hands the key to the editor's ordinary grammar unchanged, so
 * everything vim does not claim keeps working exactly as before:
 *
 *   - INSERT claims only Esc (to NORMAL). Typing, Enter, arrows, Tab,
 *     the copy/paste chords and history are the editor's.
 *   - NORMAL claims single printable keys (commands; unknown ones are
 *     swallowed, never typed) and Backspace/Delete (move left).
 *     Esc is claimed only to drop a half-typed command; otherwise it
 *     falls through to the editor's Esc, where the app makes a bare one
 *     a no-op and Esc Esc clears the draft into history (`tui-app`'s
 *     `onEscape`). Enter falls through and
 *     submits. Ctrl/Meta chords, arrows, Tab, Home/End and multi-char
 *     input (a paste, inserted verbatim as Neovim does) fall through.
 */

export interface VimRoute {
  readonly handled: boolean;
  readonly state: VimState;
  readonly buffer: VimBuffer;
}

export function routeVimKey(
  state: VimState,
  buffer: VimBuffer,
  input: string,
  key: Key,
): VimRoute {
  const pass = (next: VimState = state): VimRoute => ({
    handled: false,
    state: next,
    buffer,
  });
  if (state.mode === "insert") {
    if (!key.escape) return pass();
    return { handled: true, ...enterNormal(state, buffer) };
  }
  if (key.escape) {
    if (!hasPending(state)) return pass();
    return { handled: true, state: clearPending(state), buffer };
  }
  if (key.ctrl || key.meta || key.super || key.hyper) return pass();
  if (key.return) return pass(afterSubmit(state, buffer, key));
  if (key.backspace || key.delete) {
    return { handled: true, ...normalKey(state, buffer, "h") };
  }
  if (
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.home ||
    key.end ||
    key.pageUp ||
    key.pageDown
  ) {
    return pass();
  }
  if (input.length !== 1) return pass();
  if (input.charCodeAt(0) < 0x20 || input === "\u007f") return pass();
  return { handled: true, ...normalKey(state, buffer, input) };
}

/**
 * Enter in NORMAL submits through the editor. A sent message starts
 * the next one in INSERT, the way a shell's vi mode starts each new
 * command line; Enter that only adds a newline (Shift+Enter, a
 * trailing `\`) or meets an empty draft keeps NORMAL.
 */
function afterSubmit(state: VimState, buffer: VimBuffer, key: Key): VimState {
  const { value, cursor } = buffer;
  const newline =
    key.shift || (value.endsWith("\\") && cursor === value.length);
  if (newline || value.trim().length === 0) return clearPending(state);
  return { ...clearPending(state), mode: "insert" };
}

/** The slice of the editor's key context the vim layer reads and writes. */
export interface VimKeyContext {
  readonly input: string;
  readonly key: Key;
  readonly value: string;
  readonly cursor: number;
  readonly anchor: number | null;
  setBuffer: (next: string, cursor: number) => void;
  setAnchor: (anchor: number | null) => void;
}

/**
 * Route one keypress and apply the result to the editor. Returns the
 * next vim state and whether the editor must skip its own handling.
 * A claimed key collapses any mouse selection: the caret moved or the
 * text changed under it, so the old span means nothing any more.
 */
export function runVimKey(
  state: VimState,
  ctx: VimKeyContext,
): { state: VimState; handled: boolean } {
  const route = routeVimKey(
    state,
    { value: ctx.value, cursor: ctx.cursor },
    ctx.input,
    ctx.key,
  );
  if (route.handled) {
    if (ctx.anchor !== null) ctx.setAnchor(null);
    if (route.buffer.value !== ctx.value || route.buffer.cursor !== ctx.cursor) {
      ctx.setBuffer(route.buffer.value, route.buffer.cursor);
    }
  }
  return { state: route.state, handled: route.handled };
}
