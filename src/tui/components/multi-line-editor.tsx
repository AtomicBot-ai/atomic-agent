import { Box, useInput, type Key } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useClipboard } from "../clipboard/clipboard-context.js";
import { theme } from "../theme/theme.js";
import { EditorBody } from "./multi-line-editor-body.js";
import { cursorToRowCol } from "./multi-line-editor-cursor.js";
import { handleKey } from "./multi-line-editor-keys.js";
import { createEditorPointer } from "./multi-line-editor-pointer.js";

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
    // The buffer was replaced from outside — history recall, an Esc that
    // cleared the draft, a seeded slash command, a submit. Whatever was
    // selected no longer exists, and an anchor left pointing into the old
    // text makes the next keystroke replace a span the operator cannot
    // see (and can point past the end of a shorter buffer).
    setAnchor(null);
  }, [value]);

  /** `[start, end)` in buffer offsets, or `null` when nothing is picked. */
  const selection: readonly [number, number] | null =
    anchor === null || anchor === cursorPos
      ? null
      : [Math.min(anchor, cursorPos), Math.max(anchor, cursorPos)];
  const hasSelection = selection !== null;
  // Same render-phase-ref idiom as `activeRef` below, and load-bearing:
  // `tui-app` passes an inline arrow, so the prop has a new identity
  // every render. With the callback in the deps, the first `true` this
  // effect reports re-rendered the app, which re-ran the effect, whose
  // CLEANUP reported `false`, which re-rendered the app… a dispatch
  // ping-pong that hit React's "Maximum update depth exceeded" the
  // moment a selection existed in the real TUI. Depending only on
  // `hasSelection` reports each transition exactly once, whatever the
  // parent does with the prop's identity.
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    onSelectionChangeRef.current?.(hasSelection);
  }, [hasSelection]);
  useEffect(() => {
    // Unmounting with a live selection strands the app's copy of the
    // flag, and the flag is what makes Ctrl+C mean "copy": the global
    // layer would stand down for an editor that no longer exists, so
    // Ctrl+C would abort nothing and quit nothing for the rest of the
    // session. The composer unmounts on every Observe / Manage tab.
    return () => onSelectionChangeRef.current?.(false);
  }, []);

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

  const { placeCursorAt, beginDrag, extendDrag, endDrag } =
    createEditorPointer({
      value,
      cursorPos,
      disabled,
      setCursorPos,
      setAnchor,
      onClickFocus,
    });
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
