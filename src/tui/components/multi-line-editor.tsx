import { Box, useInput, type Key } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useClipboard } from "../clipboard/clipboard-context.js";
import { theme } from "../theme/theme.js";
import { EditorBody } from "./multi-line-editor-body.js";
import {
  cursorToRowCol,
  findWordStart,
  isOnFirstLine,
  isOnLastLine,
  lineEnd,
  lineStart,
  rowColToCursor,
} from "./multi-line-editor-cursor.js";
import { normalizeInsertText } from "./multi-line-editor-input.js";

export interface MultiLineEditorProps {
  value: string;
  placeholder?: string;
  focus: boolean;
  /** Disable interaction (reject keys silently) — keeps focus state intact. */
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Esc pressed while editor has focus. */
  onEscape?: () => void;
  /** Ctrl+C while editor has focus (overrides the default ignore for Ctrl+C). */
  onInterrupt?: () => void;
  /** Up arrow pressed while the cursor is on the first line. */
  onHistoryPrev?: () => void;
  /** Down arrow pressed while the cursor is on the last line. */
  onHistoryNext?: () => void;
  /** Tab pressed — parent may use this to accept a slash completion or navigate. */
  onTab?: () => void;
  /** Shift+Tab pressed — parent may use this for reverse navigation. */
  onShiftTab?: () => void;
  /**
   * Right arrow pressed while the cursor is at the very end of the
   * buffer. Parent may use this to accept an inline suggestion (e.g.
   * the slash-palette completion). When omitted, the editor falls back
   * to the default clamp (no-op past the end of the buffer).
   */
  onAutocomplete?: () => void;
  /**
   * Suppress the editor's own rounded border + horizontal padding. The
   * caller takes ownership of the visual chrome — used by `PromptShell`
   * to draw the opencode-style left tail and meta-row around the bare
   * editor body.
   */
  bare?: boolean;
  /**
   * Consulted before every keystroke: `true` means another layer owns
   * this key and the editor must not type it. Ink delivers a keypress
   * to every subscription, so a focused editor and a global hotkey
   * handler would otherwise both act on it — the approval prompt uses
   * this so `y` decides the prompt instead of landing in the buffer.
   */
  claimKey?: (input: string, key: Key) => boolean;
   /**
   * The operator clicked into the buffer. Fired even when the editor is
   * not focused — clicking an input is how every other application is
   * told "put the keyboard here", and the editor cannot move focus
   * itself because focus lives in the app's state.
   */
  onClickFocus?: () => void;
  /**
   * The selection appeared or disappeared. The app lifts this into its
   * own state because Ctrl+C means "copy" while text is selected and
   * "stop / quit" otherwise, and those two handlers live in different
   * key layers.
   */
  onSelectionChange?: (hasSelection: boolean) => void;
  /** Text was copied to the clipboard, so the app can say so. */
  onCopy?: (text: string) => void;
}

/**
 * Buffer-backed multi-line text editor for Ink. The external `value`
 * drives the buffer and a local cursor offset tracks where edits happen;
 * the parent owns history/slash state and is notified via `onChange`.
 *
 * Key handling:
 *   - Enter submits the trimmed buffer (and emits empty-submit as no-op)
 *   - Alt/Meta+Enter or Ctrl+J insert a newline
 *   - Backslash at end-of-line before Enter also forces a newline
 *   - Up/Down trigger `onHistoryPrev` / `onHistoryNext` when the cursor
 *     is at the top/bottom of the buffer
 *   - Large pastes (any input burst with an embedded newline) insert
 *     verbatim — bracketed paste is already unwrapped by the terminal
 */
export function MultiLineEditor(props: MultiLineEditorProps): ReactElement {
  const {
    value,
    placeholder,
    focus,
    disabled = false,
    onChange,
    onSubmit,
    onEscape,
    onInterrupt,
    onHistoryPrev,
    onHistoryNext,
    onTab,
    onShiftTab,
    onAutocomplete,
    bare = false,
    claimKey,
    onClickFocus,
    onSelectionChange,
    onCopy,
  } = props;
  const [cursorPos, setCursorPos] = useState<number>(value.length);
  /**
   * Where the current selection was started, or `null` when there is
   * none. The other end is always the caret, so extending a selection is
   * just moving the caret and leaving the anchor where it was — the same
   * model every text editor uses, and the reason Shift+arrow needs no
   * separate bookkeeping.
   */
  const [anchor, setAnchor] = useState<number | null>(null);
  const clipboard = useClipboard();
  // Distinguish our own edits (keystrokes routed through `setBuffer`)
  // from external buffer replacements: slash-seeding from panel hotkeys
  // (the LLM tab dispatches `input_changed "/"` on `/`), history recall,
  // or a command clearing the buffer. External writers cannot know the
  // editor's private cursor, so the cursor jumps to the end of the new
  // value — otherwise typing after a seeded "/" inserted BEFORE it
  // ("model/" instead of "/model"), which is why /model only ever
  // worked once per session.
  const lastInternalValue = useRef(value);

  useEffect(() => {
    if (value === lastInternalValue.current) return;
    lastInternalValue.current = value;
    setCursorPos(value.length);
  }, [value]);

  /** `[start, end)` in buffer offsets, or `null` when nothing is picked. */
  const selection: readonly [number, number] | null =
    anchor === null || anchor === cursorPos
      ? null
      : [Math.min(anchor, cursorPos), Math.max(anchor, cursorPos)];
  const hasSelection = selection !== null;
  useEffect(() => {
    onSelectionChange?.(hasSelection);
  }, [hasSelection, onSelectionChange]);

  const setBuffer = useCallback(
    (next: string, nextCursor: number) => {
      lastInternalValue.current = next;
      setCursorPos(Math.max(0, Math.min(nextCursor, next.length)));
      onChange(next);
    },
    [onChange],
  );

  // Ink tears the `isActive` subscription down in a passive effect, one
  // frame after the render that flipped `focus`. A keypress that arrives in
  // that gap — always the case when the flip and the key are processed in
  // the same stdin batch, e.g. Tab into a panel followed by the panel's
  // hotkey — is still delivered here and lands in the chat buffer of an
  // editor that is no longer focused. The ref is written during render, so
  // the callback checks the *current* focus, not the focus the subscription
  // was created with. (Render-phase write is safe: the value is derived
  // from props, never from state updated here.)
  const activeRef = useRef(focus && !disabled);
  activeRef.current = focus && !disabled;
  // Same render-phase-ref treatment as `activeRef`: the predicate reads
  // live TUI state, and a stale closure would type a key the prompt had
  // already claimed.
  const claimKeyRef = useRef(claimKey);
  claimKeyRef.current = claimKey;

  useInput(
    (input, key) => {
      if (!activeRef.current) return;
      if (disabled) return;
      if (claimKeyRef.current?.(input, key)) return;
      handleKey({
        input,
        key,
        value,
        cursor: cursorPos,
        setBuffer,
        selection,
        anchor,
        setAnchor,
        copySelection,
        onSubmit,
        onEscape,
        onInterrupt,
        onTab,
        onShiftTab,
        onAutocomplete,
        onHistoryPrev,
        onHistoryNext,
      });
    },
    { isActive: focus && !disabled },
  );

  const cursor = cursorToRowCol(value, cursorPos);
  /**
   * Place the caret where the operator clicked. `rowColToCursor` does
   * not clamp, so a click past the end of a short line would otherwise
   * run the offset into the following line; clamping here keeps a click
   * in the empty space to the right of a line meaning "end of this
   * line", which is what every editor does.
   */
  /** Buffer offset for a clicked cell, clamped to the line. */
  const offsetAt = (row: number, col: number): number => {
    const lines = value.split("\n");
    const safeRow = Math.max(0, Math.min(row, lines.length - 1));
    const safeCol = Math.max(0, Math.min(col, (lines[safeRow] ?? "").length));
    return rowColToCursor(lines, safeRow, safeCol);
  };

  /**
   * Press: drop the anchor and take the pointer. Capture matters because
   * hit-testing routes by position — without it, a drag that wanders out
   * of the composer would deliver its motion, and its release, to
   * whatever sits under the cursor, and the selection would neither
   * extend nor end.
   */
  const beginDrag = (row: number, col: number): void => {
    if (disabled) return;
    setAnchor(offsetAt(row, col));
  };

  const extendDrag = (row: number, col: number): void => {
    if (disabled) return;
    setCursorPos(offsetAt(row, col));
  };

  const endDrag = (): void => {
    // A drag that never moved is a click, not a selection.
    setAnchor((current) => (current === null || current === cursorPos ? null : current));
  };

  /**
   * Copy the selection. Both mechanisms in `copy-to-clipboard` are
   * advisory in their own way — OSC 52 has no reply and the platform
   * command may not exist — so the app is told what was copied and lets
   * the operator judge; a silent failure would be worse than a claim.
   */
  const copySelection = (): void => {
    if (!selection) return;
    const text = value.slice(selection[0], selection[1]);
    if (text.length === 0) return;
    void clipboard.copy(text);
    onCopy?.(text);
  };

  const placeCursorAt = (row: number, col: number): void => {
    if (disabled) return;
    // Ask for focus first: a click that moves a caret the operator
    // cannot then type into is a click that did nothing.
    onClickFocus?.();
    // A fresh press collapses whatever was selected — `beginDrag` sets
    // the new anchor immediately afterwards.
    setAnchor(null);
    const lines = value.split("\n");
    const safeRow = Math.max(0, Math.min(row, lines.length - 1));
    const safeCol = Math.max(0, Math.min(col, (lines[safeRow] ?? "").length));
    setCursorPos(rowColToCursor(lines, safeRow, safeCol));
  };
  if (bare) {
    return (
      <EditorBody
        value={value}
        cursor={cursor}
        placeholder={placeholder ?? ""}
        focus={focus && !disabled}
        selection={selection}
        onClickCursor={placeCursorAt}
        onDragStart={beginDrag}
        onDragMove={extendDrag}
        onDragEnd={endDrag}
      />
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor={focus && !disabled ? theme.colors.accent : theme.colors.border}
      paddingX={1}
      flexDirection="column"
    >
      <EditorBody
        value={value}
        cursor={cursor}
        placeholder={placeholder ?? ""}
        focus={focus && !disabled}
        selection={selection}
        onClickCursor={placeCursorAt}
        onDragStart={beginDrag}
        onDragMove={extendDrag}
        onDragEnd={endDrag}
      />
    </Box>
  );
}

interface KeyContext {
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
  onSubmit: (value: string) => void;
  onEscape?: () => void;
  onInterrupt?: () => void;
  onTab?: () => void;
  onShiftTab?: () => void;
  onAutocomplete?: () => void;
  onHistoryPrev?: () => void;
  onHistoryNext?: () => void;
}

function handleKey(ctx: KeyContext): void {
  const { input, key, value, cursor, setBuffer, selection } = ctx;
  if (key.ctrl && input === "c") {
    // Selected text turns Ctrl+C into copy, the way it behaves in every
    // editor people arrive from. With nothing selected it is still the
    // interrupt — `app-key-bindings` stands down for the first case, so
    // one keystroke never means both.
    if (selection) {
      ctx.copySelection();
      ctx.setAnchor(null);
      return;
    }
    if (ctx.onInterrupt) {
      ctx.onInterrupt();
      return;
    }
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
  if (key.ctrl && input === "a") {
    setBuffer(value, lineStart(value, cursor));
    return;
  }
  if (key.ctrl && input === "e") {
    setBuffer(value, lineEnd(value, cursor));
    return;
  }
  if (key.ctrl && input === "u") {
    const start = lineStart(value, cursor);
    setBuffer(value.slice(0, start) + value.slice(cursor), start);
    return;
  }
  if (key.ctrl && input === "k") {
    const end = lineEnd(value, cursor);
    setBuffer(value.slice(0, cursor) + value.slice(end), cursor);
    return;
  }
  if (key.ctrl && input === "w") {
    const wordStart = findWordStart(value, cursor);
    setBuffer(value.slice(0, wordStart) + value.slice(cursor), wordStart);
    return;
  }
  // Drop any other modifier chord (Ctrl+<letter>, Meta+<letter>) so the
  // editor does not insert it as literal text.
  if (key.ctrl || key.meta) return;
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

function insertText(ctx: KeyContext, text: string): void {
  const { value, cursor, setBuffer, selection } = ctx;
  const clean = normalizeInsertText(text);
  if (clean.length === 0) return;
  // Typing over a selection replaces it, which is what every editor
  // does and what makes select-then-retype work.
  if (selection) {
    const [from, to] = selection;
    ctx.setAnchor(null);
    const next = value.slice(0, from) + clean + value.slice(to);
    setBuffer(next, from + clean.length);
    return;
  }
  const next = value.slice(0, cursor) + clean + value.slice(cursor);
  setBuffer(next, cursor + clean.length);
}

/** Remove the selected span and put the caret where it started. */
function deleteSelection(ctx: KeyContext): void {
  const { value, setBuffer, selection } = ctx;
  if (!selection) return;
  const [from, to] = selection;
  ctx.setAnchor(null);
  setBuffer(value.slice(0, from) + value.slice(to), from);
}

/**
 * Called before every caret move. Shift keeps (or drops) an anchor so
 * the move extends a selection; an unshifted move collapses it. Holding
 * the anchor rather than a range is what lets one rule cover every
 * movement key.
 */
function updateAnchorForMove(ctx: KeyContext): void {
  if (ctx.key.shift) {
    if (ctx.anchor === null) ctx.setAnchor(ctx.cursor);
    return;
  }
  if (ctx.anchor !== null) ctx.setAnchor(null);
}

function moveCursorVertically(ctx: KeyContext, direction: -1 | 1): void {
  const { value, cursor, setBuffer } = ctx;
  const { row, col } = cursorToRowCol(value, cursor);
  const lines = value.split("\n");
  const nextRow = row + direction;
  if (nextRow < 0 || nextRow >= lines.length) return;
  const nextLine = lines[nextRow] ?? "";
  const nextCol = Math.min(col, nextLine.length);
  const nextOffset = rowColToCursor(lines, nextRow, nextCol);
  setBuffer(value, nextOffset);
}

