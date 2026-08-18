import { Box, useInput, type Key } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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
  } = props;
  const [cursorPos, setCursorPos] = useState<number>(value.length);
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

  useInput(
    (input, key) => {
      if (!activeRef.current) return;
      if (disabled) return;
      handleKey({
        input,
        key,
        value,
        cursor: cursorPos,
        setBuffer,
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
  if (bare) {
    return (
      <EditorBody
        value={value}
        cursor={cursor}
        placeholder={placeholder ?? ""}
        focus={focus && !disabled}
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
      <EditorBody value={value} cursor={cursor} placeholder={placeholder ?? ""} focus={focus && !disabled} />
    </Box>
  );
}

interface KeyContext {
  input: string;
  key: Key;
  value: string;
  cursor: number;
  setBuffer: (next: string, cursor: number) => void;
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
  const { input, key, value, cursor, setBuffer } = ctx;
  if (key.ctrl && input === "c" && ctx.onInterrupt) {
    ctx.onInterrupt();
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
    if (isOnFirstLine(value, cursor)) {
      ctx.onHistoryPrev?.();
      return;
    }
    moveCursorVertically(ctx, -1);
    return;
  }
  if (key.downArrow) {
    if (isOnLastLine(value, cursor)) {
      ctx.onHistoryNext?.();
      return;
    }
    moveCursorVertically(ctx, 1);
    return;
  }
  if (key.leftArrow) {
    setBuffer(value, Math.max(0, cursor - 1));
    return;
  }
  if (key.rightArrow) {
    if (cursor >= value.length && ctx.onAutocomplete) {
      ctx.onAutocomplete();
      return;
    }
    setBuffer(value, Math.min(value.length, cursor + 1));
    return;
  }
  if (key.backspace || key.delete) {
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
  if (key.ctrl && (input === "c" || input === "o")) return true;
  // F-keys and other multi-byte escape sequences we don't handle locally.
  if (input.startsWith("\u001b") && input.length > 1) return true;
  return false;
}

function insertText(ctx: KeyContext, text: string): void {
  const { value, cursor, setBuffer } = ctx;
  const clean = normalizeInsertText(text);
  if (clean.length === 0) return;
  const next = value.slice(0, cursor) + clean + value.slice(cursor);
  setBuffer(next, cursor + clean.length);
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

