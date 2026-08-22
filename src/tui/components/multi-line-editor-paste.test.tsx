import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import {
  ClipboardReaderProvider,
  createStaticClipboardReader,
} from "../clipboard/index.js";
import { MultiLineEditor } from "./multi-line-editor.js";

/**
 * The Ctrl+V / Cmd+V paste chord. It exists because the right-click
 * menu cannot be the only route to paste: Terminal.app and default
 * iTerm2 swallow the right button for their own menus. The chord and
 * the menu's paste row share one implementation (`useEditorClipboard`),
 * so this exercises the insertion semantics for both.
 */
const CSI = String.fromCharCode(27) + "[";
const SHIFT_LEFT = CSI + "1;2D";
const CTRL_V = String.fromCharCode(22);
/** Kitty encoding of Cmd+V: codepoint ; 1+super(8) u. */
const KITTY_SUPER_V = CSI + "118;9u";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 40));

function mount(value: string, clipboardText: string) {
  const onChange = vi.fn();
  const app = render(
    <ClipboardReaderProvider reader={createStaticClipboardReader(clipboardText)}>
      <MultiLineEditor
        value={value}
        focus
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    </ClipboardReaderProvider>,
  );
  return { ...app, onChange };
}

describe("composer paste chord", () => {
  it("pastes the clipboard at the caret with ctrl+v", async () => {
    const app = mount("hello ", "world");
    await settle();
    app.stdin.write(CTRL_V);
    await settle();
    expect(app.onChange).toHaveBeenLastCalledWith("hello world");
  });

  it("replaces the selection, like type-over", async () => {
    const app = mount("hello world", "RLD");
    await settle();
    for (let i = 0; i < 3; i += 1) {
      app.stdin.write(SHIFT_LEFT);
      await settle();
    }
    app.stdin.write(CTRL_V);
    await settle();
    expect(app.onChange).toHaveBeenLastCalledWith("hello woRLD");
  });

  it("accepts the kitty-forwarded Cmd+V and never types the letter", async () => {
    const app = mount("abc", "XY");
    await settle();
    app.stdin.write(KITTY_SUPER_V);
    await settle();
    expect(app.onChange).toHaveBeenLastCalledWith("abcXY");
  });

  it("does nothing on an empty clipboard", async () => {
    const app = mount("abc", "");
    await settle();
    app.stdin.write(CTRL_V);
    await settle();
    expect(app.onChange).not.toHaveBeenCalled();
  });
});
