import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { previewOf, QueuedMessages } from "./queued-messages.js";

describe("QueuedMessages", () => {
  it("renders nothing when the queue is empty", () => {
    const { lastFrame } = render(<QueuedMessages queued={[]} />);
    expect(lastFrame()?.trim()).toBe("");
  });

  it("lists parked messages one per row", () => {
    const { lastFrame } = render(
      <QueuedMessages queued={["run the tests", "then deploy"]} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run the tests");
    expect(frame).toContain("then deploy");
  });

  it("collapses everything past the third row into a counter", () => {
    const { lastFrame } = render(
      <QueuedMessages queued={["a", "b", "c", "d", "e"]} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("and 2 more queued");
    expect(frame).not.toContain("queued: d");
  });

  it("flattens newlines so a multi-line message stays one row", () => {
    expect(previewOf("first\nsecond", 40)).toBe("first second");
  });

  it("elides a preview past the width budget", () => {
    expect(previewOf("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
