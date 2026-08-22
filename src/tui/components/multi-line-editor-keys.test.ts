import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { handleKey, type KeyContext } from "./multi-line-editor-keys.js";

/**
 * Table tests for the editor's keystroke grammar, at the `handleKey`
 * level: no Ink render, no terminal encoding — the component-level
 * suites (selection / newline) drive real byte sequences through Ink's
 * parser for the encoding half.
 */
function k(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  } as Key;
}

interface Harness {
  ctx: KeyContext;
  setBuffer: ReturnType<typeof vi.fn>;
  setAnchor: ReturnType<typeof vi.fn>;
  copySelection: ReturnType<typeof vi.fn>;
  onInterrupt: ReturnType<typeof vi.fn>;
}

function press(
  input: string,
  key: Key,
  state: { value: string; cursor: number; anchor?: number | null },
): Harness {
  const setBuffer = vi.fn();
  const setAnchor = vi.fn();
  const copySelection = vi.fn();
  const onInterrupt = vi.fn();
  const anchor = state.anchor ?? null;
  const selection: readonly [number, number] | null =
    anchor === null || anchor === state.cursor
      ? null
      : [Math.min(anchor, state.cursor), Math.max(anchor, state.cursor)];
  const ctx: KeyContext = {
    input,
    key,
    value: state.value,
    cursor: state.cursor,
    setBuffer,
    selection,
    anchor,
    setAnchor,
    copySelection,
    onSubmit: vi.fn(),
    onInterrupt,
  };
  handleKey(ctx);
  return { ctx, setBuffer, setAnchor, copySelection, onInterrupt };
}

describe("selection extension via shift+arrows", () => {
  // "ab\ncd", cursor mid-buffer: every direction must drop the anchor at
  // the starting cursor and then move the caret.
  const value = "ab\ncd";
  const cases: ReadonlyArray<{
    name: string;
    key: Key;
    cursor: number;
    expectedCursor: number;
  }> = [
    { name: "shift+left", key: k({ leftArrow: true, shift: true }), cursor: 4, expectedCursor: 3 },
    { name: "shift+right", key: k({ rightArrow: true, shift: true }), cursor: 3, expectedCursor: 4 },
    { name: "shift+up", key: k({ upArrow: true, shift: true }), cursor: 4, expectedCursor: 1 },
    { name: "shift+down", key: k({ downArrow: true, shift: true }), cursor: 1, expectedCursor: 4 },
    // Line-boundary variants: shift+home / shift+end pick to the edges
    // of the current line.
    { name: "shift+home", key: k({ home: true, shift: true }), cursor: 4, expectedCursor: 3 },
    { name: "shift+end", key: k({ end: true, shift: true }), cursor: 3, expectedCursor: 5 },
    // Buffer-boundary variants: shift+up on the first line goes to 0
    // (never history), shift+down on the last line goes to the end.
    { name: "shift+up on first line", key: k({ upArrow: true, shift: true }), cursor: 1, expectedCursor: 0 },
    { name: "shift+down on last line", key: k({ downArrow: true, shift: true }), cursor: 4, expectedCursor: 5 },
  ];
  for (const c of cases) {
    it(`${c.name} anchors at the cursor and moves`, () => {
      const h = press("", c.key, { value, cursor: c.cursor });
      expect(h.setAnchor).toHaveBeenCalledWith(c.cursor);
      expect(h.setBuffer).toHaveBeenCalledWith(value, c.expectedCursor);
    });
  }

  it("a plain arrow collapses an existing selection", () => {
    const h = press("", k({ leftArrow: true }), {
      value,
      cursor: 4,
      anchor: 2,
    });
    expect(h.setAnchor).toHaveBeenCalledWith(null);
    expect(h.setBuffer).toHaveBeenCalledWith(value, 3);
  });

  it("plain home/end move without leaving an anchor behind", () => {
    const h = press("", k({ end: true }), { value, cursor: 3, anchor: 1 });
    expect(h.setAnchor).toHaveBeenCalledWith(null);
    expect(h.setBuffer).toHaveBeenCalledWith(value, 5);
  });
});

describe("cut (ctrl+x / kitty cmd+x)", () => {
  it("copies then removes the range in a single buffer edit", () => {
    const h = press("x", k({ ctrl: true }), {
      value: "hello world",
      cursor: 11,
      anchor: 6,
    });
    expect(h.copySelection).toHaveBeenCalledTimes(1);
    // One setBuffer call = one undoable edit; caret lands where the
    // removed range started.
    expect(h.setBuffer).toHaveBeenCalledTimes(1);
    expect(h.setBuffer).toHaveBeenCalledWith("hello ", 6);
    expect(h.setAnchor).toHaveBeenCalledWith(null);
  });

  it("kitty-reported cmd+x cuts too", () => {
    const h = press("x", k({ super: true }), {
      value: "abc",
      cursor: 3,
      anchor: 1,
    });
    expect(h.copySelection).toHaveBeenCalledTimes(1);
    expect(h.setBuffer).toHaveBeenCalledWith("a", 1);
  });

  it("does nothing without a selection", () => {
    const h = press("x", k({ ctrl: true }), { value: "abc", cursor: 3 });
    expect(h.copySelection).not.toHaveBeenCalled();
    expect(h.setBuffer).not.toHaveBeenCalled();
    expect(h.setAnchor).not.toHaveBeenCalled();
  });
});

describe("copy chords", () => {
  it("ctrl+c with a selection copies and keeps the interrupt for later", () => {
    const h = press("c", k({ ctrl: true }), {
      value: "abc",
      cursor: 3,
      anchor: 0,
    });
    expect(h.copySelection).toHaveBeenCalledTimes(1);
    expect(h.onInterrupt).not.toHaveBeenCalled();
  });

  it("ctrl+c without a selection still interrupts", () => {
    const h = press("c", k({ ctrl: true }), { value: "abc", cursor: 3 });
    expect(h.onInterrupt).toHaveBeenCalledTimes(1);
    expect(h.copySelection).not.toHaveBeenCalled();
  });

  it("kitty-reported cmd+c copies a selection", () => {
    const h = press("c", k({ super: true }), {
      value: "abc",
      cursor: 3,
      anchor: 0,
    });
    expect(h.copySelection).toHaveBeenCalledTimes(1);
    expect(h.onInterrupt).not.toHaveBeenCalled();
  });

  it("cmd+c without a selection neither interrupts nor types the letter", () => {
    const h = press("c", k({ super: true }), { value: "abc", cursor: 3 });
    expect(h.onInterrupt).not.toHaveBeenCalled();
    expect(h.setBuffer).not.toHaveBeenCalled();
  });

  it("any other cmd+letter is dropped, never inserted", () => {
    // Under kitty, a forwarded Cmd+V arrives with printable input "v" —
    // inserting it would type a stray letter on every native paste.
    const h = press("v", k({ super: true }), { value: "abc", cursor: 3 });
    expect(h.setBuffer).not.toHaveBeenCalled();
  });
});
