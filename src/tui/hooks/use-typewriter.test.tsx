import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { useTypewriter } from "./use-typewriter.js";

function Probe(props: { text: string; skip?: boolean }): React.ReactElement {
  const { revealed, done } = useTypewriter(props.text, {
    active: true,
    msPerChar: 10,
    skip: props.skip ?? false,
  });
  return <Text>{`${revealed}|${done ? "done" : "typing"}`}</Text>;
}

/**
 * Real timers on purpose. Faking `setInterval` would freeze Ink's own
 * scheduler and the frame under assertion would never repaint — the trap
 * documented in `chat-copy-button.test.tsx`. So these poll instead.
 *
 * Note the reveal rate under `ink-testing-library` is bounded by its
 * frame commits (~4/s), not by `msPerChar`; a real terminal commits at
 * ~30fps. Hence a short string here — the assertion is that the reveal
 * progresses and settles, not how fast it does so.
 */
async function waitFor(read: () => string, match: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const frame = read();
    if (match(frame)) return frame;
    if (Date.now() > deadline) return frame;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("useTypewriter", () => {
  it("reveals the text one character at a time", async () => {
    const view = render(<Probe text="atomic" />);
    const early = view.lastFrame() ?? "";
    expect(early).toContain("typing");
    expect(early.split("|")[0]?.length ?? 99).toBeLessThan("atomic".length);
    const finished = await waitFor(
      () => view.lastFrame() ?? "",
      (frame) => frame.includes("done"),
    );
    expect(finished).toContain("atomic|done");
  });

  it("skips straight to the end when asked", () => {
    const view = render(<Probe text="Local AI-First Agent" skip />);
    expect(view.lastFrame()).toContain("Local AI-First Agent|done");
  });

  it("reports done for an empty string instead of hanging", () => {
    const view = render(<Probe text="" />);
    expect(view.lastFrame()).toContain("|done");
  });
});
