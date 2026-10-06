import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { SessionPickerEntry } from "../tui-state.js";
import { SessionPicker } from "./session-picker.js";

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function entry(n: number): SessionPickerEntry {
  return {
    sessionId: `s-${n}`,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 1_000 - n,
    preview: `thread ${n}`,
    pinned: false,
  };
}

/**
 * The header counts the rows the rail has loaded, which is one page of
 * the store, not the store. The `+` is what keeps that number from
 * claiming to be a total — see `morePages` on the props.
 */
describe("SessionPicker header count", () => {
  const sessions = [entry(1), entry(2), entry(3)];

  it("marks the count with a + while the store holds more pages", () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        cursor={0}
        currentSessionId="s-1"
        morePages
      />,
    );
    expect(strip(lastFrame() ?? "")).toContain("sessions (3+)");
  });

  it("prints a bare count once the whole list is loaded", () => {
    const { lastFrame } = render(
      <SessionPicker sessions={sessions} cursor={0} currentSessionId="s-1" />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("sessions (3)");
    expect(frame).not.toContain("3+");
  });
});
