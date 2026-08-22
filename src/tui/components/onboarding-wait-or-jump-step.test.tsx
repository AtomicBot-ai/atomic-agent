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
  options: {
    cursor?: number;
    pull?: LocalModelsPullState | null;
    pullError?: string | null;
    size?: { columns: number; rows: number };
  } = {},
): string {
  const view = render(
    <OnboardingWaitOrJumpStep
      pull={options.pull === undefined ? pull() : options.pull}
      pullError={options.pullError ?? null}
      cloudLabel="Cloud model ready"
      modelLabel="gemma-4-e4b"
      cursor={options.cursor ?? 0}
      fit={computeOnboardingFit(options.size ?? { columns: 100, rows: 30 })}
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
    expect(frame).not.toContain("Retry the download");
  });

  it("defaults to jumping and moves the marker to the second row", () => {
    const rowMarker = (frame: string, label: string): boolean =>
      (frame.split("\n").find((row) => row.includes(label)) ?? "")
        .trimStart()
        .startsWith("›");
    const first = frameOf({ cursor: 0 });
    expect(rowMarker(first, "Start using the agent now")).toBe(true);
    expect(rowMarker(first, "Add another cloud provider")).toBe(false);
    const second = frameOf({ cursor: 1 });
    expect(rowMarker(second, "Start using the agent now")).toBe(false);
    expect(rowMarker(second, "Add another cloud provider")).toBe(true);
  });

  it("says the model landed instead of drawing a bar for a finished pull", () => {
    // A pull that ended cleanly while the second wizard covered this
    // screen: the reducer nulled it, so a bar here would be fabricated.
    const frame = frameOf({ pull: null, pullError: null });
    expect(frame).toContain("Cloud model ready");
    expect(frame).toContain("gemma-4-e4b downloaded");
    expect(frame).toContain("local model is ready");
    expect(frame).not.toContain("Still downloading");
    expect(frame).not.toContain("starting");
    expect(frame).not.toContain("waiting");
    expect(frame).not.toContain("░");
    // The jump row must not promise a download that is over.
    expect(frame).not.toContain("top bar");
    expect(frame).toContain("Start using the agent now");
    expect(frame).toContain("Add another cloud provider");
    expect(frame).not.toContain("Retry the download");
  });

  it("says a dead pull failed and offers to run it again", () => {
    const frame = frameOf({ pull: null, pullError: "connection reset" });
    expect(frame).toContain("download failed");
    expect(frame).toContain("connection reset");
    expect(frame).toContain("Retry the download");
    // No bar for a download that is not running.
    expect(frame).not.toContain("Still downloading");
    expect(frame).not.toContain("starting");
    expect(frame).not.toContain("waiting");
    expect(frame).not.toContain("░");
  });

  it("moves the marker onto the retry row", () => {
    const frame = frameOf({ cursor: 2, pull: null, pullError: "connection reset" });
    const retry =
      frame.split("\n").find((row) => row.includes("Retry the download")) ?? "";
    expect(retry.trimStart().startsWith("›")).toBe(true);
  });

  it("keeps the bars and the rows when a short terminal costs it the prose", () => {
    const frame = frameOf({ size: { columns: 70, rows: 17 } });
    expect(frame).not.toContain("Still downloading");
    expect(frame).not.toContain("top bar");
    expect(frame).toContain("61%");
    expect(frame).toContain("Start using the agent now");
    expect(frame).toContain("Add another cloud provider");
    // Ink overlaps rather than clips, so the whole step has to fit in
    // the rows the surface has left over at the minimal tier.
    expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("stays inside the same budget when the failure adds its row", () => {
    const frame = frameOf({
      pull: null,
      pullError: "connection reset",
      size: { columns: 70, rows: 17 },
    });
    expect(frame).toContain("Retry the download");
    // The error line replaces the two bars and the rate line, so even
    // with a third row the failed layout must not outgrow the running
    // one — the tier's budget was measured against the bars.
    expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  });
});
