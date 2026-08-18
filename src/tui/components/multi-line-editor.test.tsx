import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { MultiLineEditor } from "./multi-line-editor.js";

describe("MultiLineEditor", () => {
  function editor(focus: boolean, onChange: (v: string) => void) {
    return (
      <MultiLineEditor
        value=""
        focus={focus}
        onChange={onChange}
        onSubmit={() => {}}
      />
    );
  }

  it("accepts input while focused", async () => {
    const onChange = vi.fn();
    const { stdin, unmount } = render(editor(true, onChange));
    await new Promise((resolve) => setTimeout(resolve, 20));

    stdin.write("h");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).toHaveBeenCalledWith("h");
    unmount();
  });

  it("ignores input while unfocused", async () => {
    const onChange = vi.fn();
    const { stdin, unmount } = render(editor(false, onChange));
    await new Promise((resolve) => setTimeout(resolve, 20));

    stdin.write("h");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  });

  // The stale-subscription window this component guards against (focus
  // flipped by a render, unsubscribe effect not yet flushed, keypress
  // arrives in between) cannot be reproduced through ink-testing-library's
  // `rerender`, which flushes effects before returning. The regression
  // test for that window lives at the app level: see "a keypress landing
  // between a tab switch and its focus teardown stays out of the chat
  // buffer" in ../tui-app.test.tsx.
});
