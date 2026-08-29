import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { MultiLineEditor } from "./multi-line-editor.js";

/**
 * Enter versus newline, at the byte level.
 *
 * The distinction is a terminal-protocol fact, not an app choice: in the
 * legacy encoding Enter and Shift+Enter are the same byte (`\r`), so the
 * modifier is invisible and Shift+Enter cannot mean anything. Under the
 * kitty keyboard protocol (which `tui-command` negotiates at startup
 * when the terminal answers `CSI ? u`) Shift+Enter arrives as
 * `ESC [ 13 ; 2 u` and the composer's existing `key.shift` branch fires.
 *
 * These cases drive real byte sequences through Ink's own parser, which
 * is the only way to tell the two encodings apart from a test.
 */
const CSI = String.fromCharCode(27) + "[";

const CASES: ReadonlyArray<{
  name: string;
  bytes: string;
  expect: "submit" | "newline";
}> = [
  { name: "legacy Enter", bytes: "\r", expect: "submit" },
  // The one that cannot be fixed in JS: identical bytes to Enter.
  { name: "legacy Shift+Enter", bytes: "\r", expect: "submit" },
  { name: "legacy Alt+Enter", bytes: String.fromCharCode(27) + "\r", expect: "newline" },
  { name: "legacy Ctrl+J", bytes: "\n", expect: "newline" },
  { name: "kitty Enter", bytes: `${CSI}13u`, expect: "submit" },
  { name: "kitty Shift+Enter", bytes: `${CSI}13;2u`, expect: "newline" },
  { name: "kitty Alt+Enter", bytes: `${CSI}13;3u`, expect: "newline" },
  { name: "kitty Ctrl+Enter", bytes: `${CSI}13;5u`, expect: "newline" },
  // Under kitty this stops being a literal "\n" and becomes ctrl+j.
  { name: "kitty Ctrl+J", bytes: `${CSI}106;5u`, expect: "newline" },
];

describe("composer newline encoding", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} → ${testCase.expect}`, async () => {
      const onSubmit = vi.fn();
      const onChange = vi.fn();
      const { stdin, unmount } = render(
        <MultiLineEditor
          value="hi"
          focus
          onChange={onChange}
          onSubmit={onSubmit}
        />,
      );
      await new Promise((r) => setTimeout(r, 30));
      stdin.write(testCase.bytes);
      await new Promise((r) => setTimeout(r, 60));

      if (testCase.expect === "submit") {
        expect(onSubmit).toHaveBeenCalledWith("hi");
        expect(onChange).not.toHaveBeenCalled();
      } else {
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledWith("hi\n");
      }
      unmount();
    });
  }
});
