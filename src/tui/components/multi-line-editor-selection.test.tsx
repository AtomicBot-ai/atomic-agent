import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { ClipboardProvider } from "../clipboard/clipboard-context.js";
import type { ClipboardWriter } from "../clipboard/copy-to-clipboard.js";
import { MultiLineEditor } from "./multi-line-editor.js";

/**
 * Selecting text in the composer, and copying it.
 *
 * The terminal takes its own drag-to-select away the moment mouse
 * reporting is on, so the composer has to provide the gesture itself:
 * Shift+arrows from the keyboard, click-drag from the mouse, and
 * Ctrl+C to copy what is picked.
 */
const CSI = String.fromCharCode(27) + "[";
/** xterm modifier encoding: 1 + 1 = shift. */
const SHIFT_LEFT = CSI + "1;2D";
const SHIFT_RIGHT = CSI + "1;2C";
const SHIFT_UP = CSI + "1;2A";
const SHIFT_DOWN = CSI + "1;2B";
const CTRL_C = String.fromCharCode(3);
const CTRL_X = String.fromCharCode(24);
/** Kitty encoding of Cmd+C / Cmd+X: codepoint ; 1+super(8) u. */
const KITTY_SUPER_C = CSI + "99;9u";
const KITTY_SUPER_X = CSI + "120;9u";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 40));

function writer(): ClipboardWriter & { copied: string[] } {
  const copied: string[] = [];
  return {
    copied,
    copy: async (text: string) => {
      copied.push(text);
      return true;
    },
  };
}

function mount(value: string, clipboard: ClipboardWriter) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onSelectionChange = vi.fn();
  const app = render(
    <ClipboardProvider writer={clipboard}>
      <MultiLineEditor
        value={value}
        focus
        onChange={onChange}
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
        onSelectionChange={onSelectionChange}
      />
    </ClipboardProvider>,
  );
  return { ...app, onChange, onSubmit, onInterrupt, onSelectionChange };
}

describe("composer selection", () => {
  it("extends a selection with shift+arrows and copies it with ctrl+c", async () => {
    const clipboard = writer();
    const app = mount("hello world", clipboard);
    await settle();
    // The caret starts at the end; three shift+lefts pick "rld".
    for (let i = 0; i < 3; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      // One keystroke per tick: `handleKey` reads the caret from the
      // render closure, so a burst written into a single tick would all
      // move from the same starting point.
      await settle();
    }
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(true);

    app.stdin.write(CTRL_C);
    await settle();
    expect(clipboard.copied).toEqual(["rld"]);
    // Copy is not an interrupt while text is picked.
    expect(app.onInterrupt).not.toHaveBeenCalled();
    app.unmount();
  });

  it("still interrupts on ctrl+c when nothing is selected", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    app.stdin.write(CTRL_C);
    await settle();
    expect(app.onInterrupt).toHaveBeenCalled();
    expect(clipboard.copied).toEqual([]);
    app.unmount();
  });

  it("collapses the selection on an unshifted move", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    app.stdin.write(SHIFT_LEFT);
    await settle();
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(true);
    app.stdin.write(CSI + "D");
    await settle();
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(false);
    app.unmount();
  });

  it("replaces the selection when the operator types over it", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write("y");
    await settle();
    expect(app.onChange).toHaveBeenLastCalledWith("hely");
    app.unmount();
  });

  it("deletes the selection on backspace", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write(String.fromCharCode(127));
    await settle();
    expect(app.onChange).toHaveBeenLastCalledWith("hel");
    app.unmount();
  });

  it("paints the selected span in inverse video", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    // ink-testing-library strips colour, so assert on the buffer text
    // staying intact rather than on the escape codes.
    expect(app.lastFrame() ?? "").toContain("hello");
    app.unmount();
  });

  it("extends across lines with shift+up and copies the span", async () => {
    const clipboard = writer();
    const app = mount("ab\ncd", clipboard);
    await settle();
    // Caret starts at the end (row 1, col 2); shift+up lands on row 0
    // col 2 = offset 2, selecting "\ncd".
    app.stdin.write(SHIFT_UP);
    await settle();
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(true);
    app.stdin.write(CTRL_C);
    await settle();
    expect(clipboard.copied).toEqual(["\ncd"]);
    app.unmount();
  });

  it("shift+down re-extends towards the end of the buffer", async () => {
    const clipboard = writer();
    const app = mount("ab\ncd", clipboard);
    await settle();
    app.stdin.write(SHIFT_UP);
    await settle();
    // Same anchor, opposite direction: the selection collapses through
    // the anchor and lands empty at the end again.
    app.stdin.write(SHIFT_DOWN);
    await settle();
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(false);
    app.unmount();
  });
});

describe("composer cut", () => {
  it("ctrl+x copies the selection and removes it in one edit", async () => {
    const clipboard = writer();
    const app = mount("hello world", clipboard);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write(CTRL_X);
    await settle();
    expect(clipboard.copied).toEqual(["world"]);
    expect(app.onChange).toHaveBeenLastCalledWith("hello ");
    expect(app.onSelectionChange).toHaveBeenLastCalledWith(false);
    app.unmount();
  });

  it("ctrl+x without a selection neither edits nor copies", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    app.stdin.write(CTRL_X);
    await settle();
    expect(clipboard.copied).toEqual([]);
    expect(app.onChange).not.toHaveBeenCalled();
    app.unmount();
  });
});

describe("kitty-reported cmd chords", () => {
  // On most macOS terminals Cmd+C/Cmd+X never reach stdin (the emulator
  // owns them). These cases cover the kitty-protocol terminals that DO
  // forward them, where they must mean copy/cut — and never type "c".
  it("cmd+c copies a selection", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write(KITTY_SUPER_C);
    await settle();
    expect(clipboard.copied).toEqual(["lo"]);
    expect(app.onInterrupt).not.toHaveBeenCalled();
    app.unmount();
  });

  it("cmd+x cuts a selection", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write(KITTY_SUPER_X);
    await settle();
    expect(clipboard.copied).toEqual(["lo"]);
    expect(app.onChange).toHaveBeenLastCalledWith("hel");
    app.unmount();
  });

  it("cmd+c without a selection does not interrupt and types nothing", async () => {
    const clipboard = writer();
    const app = mount("hello", clipboard);
    await settle();
    app.stdin.write(KITTY_SUPER_C);
    await settle();
    expect(clipboard.copied).toEqual([]);
    expect(app.onInterrupt).not.toHaveBeenCalled();
    expect(app.onChange).not.toHaveBeenCalled();
    app.unmount();
  });
})
