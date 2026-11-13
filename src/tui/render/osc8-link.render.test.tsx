import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { OSC8_CONSTANTS, Osc8Link } from "./osc8-link.js";

/**
 * Ink 8 sanitizes text content before layout: C0 controls are dropped
 * and only SGR and OSC escapes are kept (ATO-648). These pin that the
 * hyperlink and its colour still reach the frame through that pass, so
 * a renderer change that starts eating either shows up here rather than
 * as dead links in a user's terminal.
 */
describe("Osc8Link through Ink's renderer", () => {
  it("keeps the OSC 8 open and close escapes around the label", () => {
    const { lastFrame } = render(
      <Osc8Link url="https://example.com/docs" label="docs" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      `${OSC8_CONSTANTS.open}https://example.com/docs${OSC8_CONSTANTS.terminator}`,
    );
    expect(frame).toContain(OSC8_CONSTANTS.close);
    expect(frame.indexOf("docs")).toBeGreaterThan(
      frame.indexOf(OSC8_CONSTANTS.terminator),
    );
  });

  it("keeps SGR colour escapes in text content", () => {
    const { lastFrame } = render(<Text>{"\u001b[31mred\u001b[39m"}</Text>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("red");
    expect(frame).toContain("\u001b[31m");
  });

  it("drops stray C0 control characters from text content", () => {
    // A bell or carriage return inside a tool's output used to reach the
    // terminal as-is; Ink 8 strips them so they cannot move the cursor
    // or ring the bell mid-frame.
    const { lastFrame } = render(<Text>{"a\u0007b\rc"}</Text>);
    expect(lastFrame()).toBe("abc");
  });
});
