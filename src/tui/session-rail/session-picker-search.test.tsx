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
 * ATO-1153: the picker gets its rows already narrowed by the search
 * (`visiblePickerSessions`) and says what they are narrowed by.
 */
describe("SessionPicker search", () => {
  it("invites typing while there is no query", () => {
    const { lastFrame } = render(
      <SessionPicker sessions={[entry(1)]} cursor={0} currentSessionId={null} />,
    );
    expect(strip(lastFrame() ?? "")).toContain("type to search");
  });

  it("names the query and counts its matches", () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={[entry(1)]}
        cursor={0}
        currentSessionId={null}
        query="  thread "
        morePages
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain('sessions matching "thread" (1)');
    expect(frame).not.toContain("type to search");
  });

  it("says nothing matched instead of claiming there are no sessions", () => {
    const { lastFrame } = render(
      <SessionPicker sessions={[]} cursor={0} currentSessionId={null} query="zzz" />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain('no loaded session matches "zzz"');
    expect(frame).not.toContain("no persisted sessions yet");
  });
});
