import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { renderPickList } from "./wizard-pick-list.js";

/**
 * Constrain the list to a fixed inner width so the truncation guard is
 * deterministic regardless of the test host's real terminal size —
 * `wrap="truncate-end"` clips to the parent Box, so a 40-column Box is
 * a stand-in for a 40-column terminal.
 */
function narrow(node: ReturnType<typeof renderPickList>, columns: number) {
  return render(<Box width={columns}>{node}</Box>);
}

/**
 * Longest line any rendered frame row reaches, in physical columns.
 * A wrapped row would split one option across two lines and desync the
 * windowed height math, so the guard is: no visible line exceeds the
 * viewport width, and no option's text bleeds onto a second line.
 */
function widestLine(frame: string): number {
  return Math.max(0, ...frame.split("\n").map((line) => line.length));
}

describe("renderPickList narrow-width rendering", () => {
  const longLabel =
    "Together AI — broad open-weight catalog vendored without a key, long enough to overflow";

  it("truncates a long option instead of wrapping it onto a second line", () => {
    const { lastFrame } = narrow(
      renderPickList({
        title: "Provider",
        options: [{ label: longLabel }, { label: "Short one" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      40,
    );
    const frame = lastFrame() ?? "";
    // The whole frame stays within the viewport — no wrapped overflow.
    expect(widestLine(frame)).toBeLessThanOrEqual(40);
    // The long label is present but clipped: its head shows, its tail does not.
    expect(frame).toContain("Together AI");
    expect(frame).not.toContain("overflow");
    // The following option is never fused into the truncated row: it
    // still appears on its own line intact.
    expect(frame).toContain("Short one");
  });

  it("leaves a short option intact", () => {
    const { lastFrame } = narrow(
      renderPickList({
        title: "Provider",
        options: [{ label: "OpenRouter" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      80,
    );
    expect(lastFrame() ?? "").toContain("OpenRouter");
  });
});
