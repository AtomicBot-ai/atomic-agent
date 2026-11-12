import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { SessionPickerEntry } from "../tui-state.js";
import { SessionPicker } from "./session-picker.js";

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function entry(n: number, folder?: string): SessionPickerEntry {
  return {
    sessionId: `s-${n}`,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 1_000 - n,
    preview: `thread ${n}`,
    pinned: false,
    ...(folder !== undefined ? { folder } : {}),
  };
}

/**
 * ATO-1180: the rail hands the picker its list already grouped by the
 * desktop's chat folders; the picker draws a header above each group.
 */
describe("SessionPicker folder headers", () => {
  it("draws a header over each folder's rows and over the unfiled rest", () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={[entry(1, "Work"), entry(2, "Work"), entry(3)]}
        cursor={0}
        currentSessionId={null}
      />,
    );
    const lines = strip(lastFrame() ?? "").split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("▾ Work")).toBeGreaterThan(-1);
    expect(at("▾ Work")).toBeLessThan(at("thread 1"));
    expect(at("▾ no folder")).toBeGreaterThan(at("thread 2"));
    expect(at("▾ no folder")).toBeLessThan(at("thread 3"));
    expect(lines.filter((l) => l.includes("▾ Work"))).toHaveLength(1);
  });

  it("draws no header when no session is in a folder", () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={[entry(1), entry(2)]}
        cursor={0}
        currentSessionId={null}
      />,
    );
    expect(strip(lastFrame() ?? "")).not.toContain("▾");
  });
});
