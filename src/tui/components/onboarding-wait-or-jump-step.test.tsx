import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { OnboardingWaitOrJumpStep } from "./onboarding-wait-or-jump-step.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function pull(over: Partial<LocalModelsPullState> = {}): LocalModelsPullState {
  return {
    kind: "chat",
    modelId: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    percent: 61,
    transferredBytes: 2_600_000_000,
    totalBytes: 4_220_000_000,
    error: null,
    ...over,
  };
}

function frameOf(
  cursor = 0,
  over: Partial<LocalModelsPullState> = {},
  size = { columns: 100, rows: 30 },
): string {
  const view = render(
    <OnboardingWaitOrJumpStep
      pull={pull(over)}
      cloudLabel="Cloud model ready"
      modelLabel="gemma-4-e4b"
      cursor={cursor}
      fit={computeOnboardingFit(size)}
    />,
  );
  return strip(view.lastFrame() ?? "");
}

describe("OnboardingWaitOrJumpStep", () => {
  it("draws the download it says is still running", () => {
    const frame = frameOf();
    expect(frame).toContain("Cloud model ready");
    expect(frame).toContain("Still downloading gemma-4-e4b");
    const weights = frame.split("\n").find((row) => row.includes("model weights")) ?? "";
    // The same bar the download screen draws: percent and bytes, not a
    // sentence claiming progress the screen never shows.
    expect(weights).toContain("█");
    expect(weights).toContain("░");
    expect(weights).toContain("61%");
    expect(weights).toContain("2.6 GB / 4.2 GB");
    expect(frame).toContain("llama.cpp runtime");
  });

  it("offers leaving and one more provider, and never offers waiting", () => {
    const frame = frameOf();
    expect(frame).toContain("Start using the agent now");
    expect(frame).toContain("top bar");
    expect(frame).toContain("Add another cloud provider");
    expect(frame).not.toContain("Wait here");
  });

  it("defaults to jumping and moves the marker to the second row", () => {
    const rowMarker = (frame: string, label: string): boolean =>
      (frame.split("\n").find((row) => row.includes(label)) ?? "")
        .trimStart()
        .startsWith("\u203a");
    const first = frameOf(0);
    expect(rowMarker(first, "Start using the agent now")).toBe(true);
    expect(rowMarker(first, "Add another cloud provider")).toBe(false);
    const second = frameOf(1);
    expect(rowMarker(second, "Start using the agent now")).toBe(false);
    expect(rowMarker(second, "Add another cloud provider")).toBe(true);
  });

  it("surfaces a stalled pull rather than a bar that stopped moving", () => {
    expect(frameOf(0, { error: "connection reset" })).toContain("connection reset");
  });

  it("keeps the bars and the rows when a short terminal costs it the prose", () => {
    const frame = frameOf(0, {}, { columns: 70, rows: 17 });
    expect(frame).not.toContain("Still downloading");
    expect(frame).not.toContain("top bar");
    expect(frame).toContain("61%");
    expect(frame).toContain("Start using the agent now");
    expect(frame).toContain("Add another cloud provider");
    // Ink overlaps rather than clips, so the whole step has to fit in
    // the rows the surface has left over at the minimal tier.
    expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  });
});
