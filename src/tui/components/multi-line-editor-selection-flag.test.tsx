import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { MultiLineEditor } from "./multi-line-editor.js";

/**
 * The selection flag the app keeps is what makes Ctrl+C mean "copy"
 * instead of "stop". If the editor unmounts while a selection is live
 * — which it does on every Observe / Manage tab, since the composer is
 * Run-only — a stranded `true` leaves Ctrl+C claimed by nobody: no
 * abort, no quit, for the rest of the session.
 */
const SHIFT_LEFT = String.fromCharCode(27) + "[1;2D";
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 40));

describe("composer selection flag", () => {
  it("clears when the editor unmounts with a live selection", async () => {
    const onSelectionChange = vi.fn();
    const app = render(
      <MultiLineEditor
        value="hello"
        focus
        onChange={() => {}}
        onSubmit={() => {}}
        onSelectionChange={onSelectionChange}
      />,
    );
    await settle();
    app.stdin.write(SHIFT_LEFT);
    await settle();
    expect(onSelectionChange).toHaveBeenLastCalledWith(true);

    app.unmount();
    await settle();
    expect(onSelectionChange).toHaveBeenLastCalledWith(false);
  });

  it("clears when the buffer is replaced from outside", async () => {
    // History recall, an Esc that cleared the draft, a seeded slash
    // command: the selected text no longer exists, and an anchor left
    // pointing into it makes the next keystroke replace a span the
    // operator cannot see.
    const onSelectionChange = vi.fn();
    const app = render(
      <MultiLineEditor
        value="hello"
        focus
        onChange={() => {}}
        onSubmit={() => {}}
        onSelectionChange={onSelectionChange}
      />,
    );
    await settle();
    app.stdin.write(SHIFT_LEFT);
    await settle();
    expect(onSelectionChange).toHaveBeenLastCalledWith(true);

    app.rerender(
      <MultiLineEditor
        value=""
        focus
        onChange={() => {}}
        onSubmit={() => {}}
        onSelectionChange={onSelectionChange}
      />,
    );
    // Poll rather than assume one tick: the effect that clears the
    // anchor runs after the rerender commits, and a loaded suite makes
    // that gap wider than a single settle.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (onSelectionChange.mock.calls.at(-1)?.[0] === false) break;
      await settle();
    }
    expect(onSelectionChange).toHaveBeenLastCalledWith(false);
    app.unmount();
  });
});
