import type { Key } from "ink";
import {
  findWordStart,
  isOnFirstLine,
  isOnLastLine,
  lineEnd,
  lineStart,
} from "./multi-line-editor-cursor.js";
import {
  deleteSelection,
  insertText,
  moveCursorVertically,
  updateAnchorForMove,
} from "./multi-line-editor-edits.js";

/**
 * Everything `handleKey` may read or call, handed in by the component.
 * Pure by construction — the editor's keystroke grammar lives here so it
 * can be table-tested without rendering Ink.
 */
export interface KeyContext {
  input: string;
  key: Key;
  value: string;
  cursor: number;
  setBuffer: (next: string, cursor: number) => void;
  /** Selected span in buffer offsets, or `null`. */
  selection: readonly [number, number] | null;
  /** Where the selection was started; `null` means none is active. */
  anchor: number | null;
  setAnchor: (anchor: number | null) => void;
  /** Copy the current selection; the caller keeps or clears it. */
  copySelection: () => void;
  /**
   * Paste the system clipboard at the caret (replacing any selection).
   * Owned by the component because reading the clipboard is async and
   * this grammar is synchronous by design.
   */
  onPaste?: () => void;
  onSubmit: (value: string) => void;
  onEscape?: () => void;
  onInterrupt?: () => void;
  onTab?: () => void;
  onShiftTab?: () => void;
  onAutocomplete?: () => void;
  onHistoryPrev?: () => void;
  onHistoryNext?: () => void;
}

/**
 * Copy/cut chords accept Ctrl and — where the kitty protocol reports it —
 * the macOS Cmd key (`key.super`). On most macOS terminals Cmd+C/Cmd+X
 * never reach stdin at all (the emulator owns them as its native
 * copy/paste); when a kitty-protocol terminal *does* forward them, they
 * must mean copy/cut here and must never fall through and type the
 * letter.
 */
function isCopyChord(input: string, key: Key): boolean {
  return (key.ctrl || key.super) && input === "c";
}

function isCutChord(input: string, key: Key): boolean {
  return (key.ctrl || key.super) && input === "x";
}

/**
 * Ctrl+V / Cmd+V. This chord exists because the right-click menu cannot
 * be the only route to paste: Terminal.app and default iTerm2 swallow
 * the right button for their own menus and the TUI never sees it.
 */
function isPasteChord(input: string, key: Key): boolean {
  return (key.ctrl || key.super) && input === "v";
}

export function handleKey(ctx: KeyContext): void {
  const { input, key, value, cursor, setBuffer, selection } = ctx;
  if (isCopyChord(input, key)) {
    // Selected text turns Ctrl+C into copy, the way it behaves in every
    // editor people arrive from. With nothing selected it is still the
    // interrupt — `app-key-bindings` stands down for the first case, so
    // one keystroke never means both.
    if (selection) {
      ctx.copySelection();
      ctx.setAnchor(null);
      return;
    }
    // Cmd+C carries no interrupt meaning anywhere; only Ctrl+C does.
    if (key.ctrl && ctx.onInterrupt) {
      ctx.onInterrupt();
      return;
    }
    if (key.super) return;
  }
  if (isCutChord(input, key)) {
    if (selection) {
      // Copy first, then remove. The removal is a single `setBuffer`
      // call, so the whole cut is one buffer edit — nothing can observe
      // a copied-but-not-yet-deleted intermediate state.
      ctx.copySelection();
      deleteSelection(ctx);
    }
    // Without a selection the chord means nothing in the editor.
    // Returning without acting does not starve other layers: Ink hands
    // every keypress to every subscription, so a future global claim on
    // Ctrl+X would still see it.
    return;
  }
  if (isPasteChord(input, key)) {
    ctx.onPaste?.();
    return;
  }
  // Ignore keys owned by the global app-level handler so the editor
  // never inserts Ctrl+C as "c" or swallows F-key escape sequences.
  if (isGlobalHotkey(input, key)) return;
  if (key.escape) {
    ctx.onEscape?.();
    return;
  }
  if (key.tab && key.shift) {
    ctx.onShiftTab?.();
    return;
  }
  if (key.tab) {
    ctx.onTab?.();
    return;
  }
  // Ctrl+J is a documented newline binding. In the legacy encoding it
  // arrives as a literal "\n" and falls through to the text-insert path
  // below; under the kitty protocol it arrives as `ctrl` + `j` and would
  // otherwise be dropped by the catch-all, silently losing the binding.
  if (key.ctrl && input === "j") {
    insertText(ctx, "\n");
    return;
  }
  if (key.return) {
    const newline = key.meta || key.shift || key.ctrl;
    const trailingBackslash = value.endsWith("\\") && cursor === value.length;
    if (newline) {
      insertText(ctx, "\n");
      return;
    }
    if (trailingBackslash) {
      const withoutSlash = value.slice(0, -1);
      setBuffer(`${withoutSlash}\n`, withoutSlash.length + 1);
      return;
    }
    ctx.onSubmit(value);
    return;
  }
  if (key.upArrow) {
    // Shift+Up on the first line extends to the start of the buffer
    // instead of recalling history — history would replace the very
    // text being selected.
    if (isOnFirstLine(value, cursor) && !key.shift) {
      ctx.onHistoryPrev?.();
      return;
    }
    updateAnchorForMove(ctx);
    if (isOnFirstLine(value, cursor)) {
      setBuffer(value, 0);
      return;
    }
    moveCursorVertically(ctx, -1);
    return;
  }
  if (key.downArrow) {
    if (isOnLastLine(value, cursor) && !key.shift) {
      ctx.onHistoryNext?.();
      return;
    }
    updateAnchorForMove(ctx);
    if (isOnLastLine(value, cursor)) {
      setBuffer(value, value.length);
      return;
    }
    moveCursorVertically(ctx, 1);
    return;
  }
  if (key.leftArrow) {
    updateAnchorForMove(ctx);
    setBuffer(value, Math.max(0, cursor - 1));
    return;
  }
  if (key.rightArrow) {
    // Shift+Right extends the selection to the end of the buffer rather
    // than accepting a completion: the operator is picking text, not
    // asking for the rest of a command.
    if (cursor >= value.length && ctx.onAutocomplete && !key.shift) {
      ctx.onAutocomplete();
      return;
    }
    updateAnchorForMove(ctx);
    setBuffer(value, Math.min(value.length, cursor + 1));
    return;
  }
  // Home/End move within the current line, and extend the selection when
  // shifted — same anchor rule as the arrows, so Shift+End picks to the
  // end of the line the way it does in a GUI editor. (Ctrl+A/Ctrl+E stay
  // the emacs moves below: they deliberately collapse the selection.)
  if (key.home) {
    updateAnchorForMove(ctx);
    setBuffer(value, lineStart(value, cursor));
    return;
  }
  if (key.end) {
    updateAnchorForMove(ctx);
    setBuffer(value, lineEnd(value, cursor));
    return;
  }
  if (key.backspace || key.delete) {
    if (selection) {
      deleteSelection(ctx);
      return;
    }
    if (key.delete && !key.backspace) {
      // Forward delete
      if (cursor < value.length) {
        const next = value.slice(0, cursor) + value.slice(cursor + 1);
        setBuffer(next, cursor);
      }
      return;
    }
    if (cursor > 0) {
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setBuffer(next, cursor - 1);
    }
    return;
  }
  // The emacs bindings all move the caret or shorten the buffer, and a
  // selection cannot survive either: an anchor left behind points into
  // text that has moved (so Ctrl+C copies the wrong span) or past the
  // end of a shorter buffer (so the next character replaces everything
  // from the anchor onwards). Each one collapses it first.
  if (key.ctrl && input === "a") {
    ctx.setAnchor(null);
    setBuffer(value, lineStart(value, cursor));
    return;
  }
  if (key.ctrl && input === "e") {
    ctx.setAnchor(null);
    setBuffer(value, lineEnd(value, cursor));
    return;
  }
  if (key.ctrl && input === "u") {
    if (selection) {
      deleteSelection(ctx);
      return;
    }
    const start = lineStart(value, cursor);
    setBuffer(value.slice(0, start) + value.slice(cursor), start);
    return;
  }
  if (key.ctrl && input === "k") {
    if (selection) {
      deleteSelection(ctx);
      return;
    }
    const end = lineEnd(value, cursor);
    setBuffer(value.slice(0, cursor) + value.slice(end), cursor);
    return;
  }
  if (key.ctrl && input === "w") {
    if (selection) {
      deleteSelection(ctx);
      return;
    }
    const wordStart = findWordStart(value, cursor);
    setBuffer(value.slice(0, wordStart) + value.slice(cursor), wordStart);
    return;
  }
  // Drop any other modifier chord (Ctrl/Meta, and the kitty-only
  // Super/Hyper) so the editor does not insert it as literal text —
  // under the kitty protocol a forwarded Cmd+letter arrives with
  // printable `input` and would otherwise type the letter.
  if (key.ctrl || key.meta || key.super || key.hyper) return;
  if (input.length === 0) return;
  // A single control char pressed on its own is ignored — but a
  // multi-char paste burst is always sanitised and inserted, even when
  // its first byte is a CR/control, because `normalizeInsertText` strips
  // the offending bytes.
  if (
    input.length === 1 &&
    input.charCodeAt(0) < 0x20 &&
    input !== "\n" &&
    input !== "\t"
  ) {
    return;
  }
  insertText(ctx, input);
}

function isGlobalHotkey(input: string, key: Key): boolean {
  if (key.ctrl && (input === "c" || input === "o" || input === "t")) return true;
  // F-keys and other multi-byte escape sequences we don't handle locally.
  if (input.startsWith("\u001b") && input.length > 1) return true;
  return false;
}
