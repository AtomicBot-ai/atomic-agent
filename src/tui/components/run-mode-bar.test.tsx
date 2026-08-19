import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { RunModeBar } from "./run-mode-bar.js";
import { createInitialRunModePanelState } from "../run-mode/run-mode-panel-state.js";
import type { RunModePanelState } from "../run-mode/run-mode-panel-state.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function panelOf(over: Partial<RunModePanelState> = {}): RunModePanelState {
  return { ...createInitialRunModePanelState(), ...over };
}

function frameOf(panel: RunModePanelState): string {
  const { lastFrame } = render(<RunModeBar panel={panel} />);
  return stripAnsi(lastFrame() ?? "");
}

describe("RunModeBar", () => {
  it("lists all three modes", () => {
    const frame = frameOf(panelOf());
    expect(frame).toContain("Local");
    expect(frame).toContain("Cloud");
    expect(frame).toContain("Fusion");
  });

  it("marks the mode in force with the chevron", () => {
    expect(frameOf(panelOf({ effective: "local" }))).toContain("\u25b8 Local");
    expect(frameOf(panelOf({ effective: "cloud" }))).toContain("\u25b8 Cloud");
  });

  it("shows the dial only while fusion is actually in force", () => {
    expect(
      frameOf(panelOf({ effective: "fusion", cloudShare: 40 })),
    ).toContain("Fusion 40%");
    expect(
      frameOf(panelOf({ effective: "local", cloudShare: 40 })),
    ).not.toContain("40%");
  });

  it("says why an unreachable mode is unreachable", () => {
    // Silently hiding the pill would leave the operator wondering where
    // Cloud went.
    expect(frameOf(panelOf({ cloudProviderMissing: true }))).toContain(
      "no cloud provider",
    );
  });

  it("renders as a single row", () => {
    expect(frameOf(panelOf({ effective: "fusion" })).split("\n")).toHaveLength(1);
  });

  it("surfaces a failed switch inline", () => {
    expect(
      frameOf(panelOf({ lastError: "provider not configured" })),
    ).toContain("provider not configured");
  });
});
