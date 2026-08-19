import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { RunModePicker } from "./run-mode-picker.js";
import { createInitialRunModePanelState } from "../run-mode/run-mode-panel-state.js";
import type { RunModePanelState } from "../run-mode/run-mode-panel-state.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function open(over: Partial<RunModePanelState> = {}): RunModePanelState {
  return {
    ...createInitialRunModePanelState(),
    picker: {
      cursor: 2,
      draftMode: "fusion",
      draftCloudShare: 40,
      digitBuffer: "",
    },
    ...over,
  };
}

function frameOf(panel: RunModePanelState): string {
  const { lastFrame } = render(<RunModePicker panel={panel} />);
  return stripAnsi(lastFrame() ?? "");
}

describe("RunModePicker", () => {
  it("renders nothing while closed", () => {
    const { lastFrame } = render(
      <RunModePicker panel={createInitialRunModePanelState()} />,
    );
    expect(stripAnsi(lastFrame() ?? "").trim()).toBe("");
  });

  it("lists the modes with the draft highlighted", () => {
    const frame = frameOf(open());
    expect(frame).toContain("Local");
    expect(frame).toContain("\u25b8 Fusion");
  });

  it("shows the dial value and a bar", () => {
    const frame = frameOf(open());
    expect(frame).toContain("40%");
    expect(frame).toMatch(/[\u2588\u2591]/);
  });

  it("explains what the dial means in prose", () => {
    expect(frameOf(open())).toContain("steps scoring \u2265 60");
  });

  it("names the extremes plainly", () => {
    const allLocal = open();
    allLocal.picker!.draftCloudShare = 0;
    expect(frameOf(allLocal)).toContain("everything local");
    const allCloud = open();
    allCloud.picker!.draftCloudShare = 100;
    expect(frameOf(allCloud)).toContain("everything cloud");
  });

  it("says the dial is inert unless Fusion is selected", () => {
    const local = open();
    local.picker!.draftMode = "local";
    local.picker!.cursor = 0;
    expect(frameOf(local)).toContain("only applies to Fusion");
  });

  it("surfaces a degradation warning", () => {
    expect(
      frameOf(open({ degradedMessage: "Fusion needs a cloud orchestrator" })),
    ).toContain("Fusion needs a cloud orchestrator");
  });

  it("advertises its own key bindings", () => {
    const frame = frameOf(open());
    expect(frame).toContain("enter apply");
    expect(frame).toContain("esc cancel");
  });
});
