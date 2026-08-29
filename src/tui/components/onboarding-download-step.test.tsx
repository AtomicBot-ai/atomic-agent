import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  countOnboardingDownloadBlockRows,
  OnboardingDownloadStep,
} from "./onboarding-download-step.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

type View = ReturnType<typeof render>;

const mounted: View[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function mount(node: React.ReactElement): View {
  const view = render(node);
  mounted.push(view);
  return view;
}

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

function pull(over: Partial<LocalModelsPullState> = {}): LocalModelsPullState {
  return {
    kind: "chat",
    modelId: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    percent: 38,
    transferredBytes: 1_600_000_000,
    totalBytes: 4_220_000_000,
    error: null,
    ...over,
  };
}

function step(props: Partial<React.ComponentProps<typeof OnboardingDownloadStep>> = {}) {
  return (
    <OnboardingDownloadStep
      pull={pull()}
      pullError={null}
      modelLabel="gemma-4-e4b"
      {...props}
    />
  );
}

describe("OnboardingDownloadStep", () => {
  it("says what is happening before the first progress event lands", () => {
    const view = mount(step({ pull: null }));
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Downloading gemma-4-e4b");
    expect(frame).toContain("starting");
  });

  it("reports bytes and percent for the phase in flight", () => {
    const view = mount(step());
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("model weights");
    expect(frame).toContain("38%");
    expect(frame).toContain("1.6 GB / 4.2 GB");
  });

  it("shows the runtime phase as done once the weights start", () => {
    const view = mount(step());
    const line = strip(view.lastFrame() ?? "")
      .split("\n")
      .find((row) => row.includes("llama.cpp runtime"));
    expect(line).toContain("done");
  });

  it("marks the weights as waiting while the runtime is still coming down", () => {
    const view = mount(
      step({ pull: pull({ kind: "backend", modelId: "_backend", percent: 6 }) }),
    );
    const frame = strip(view.lastFrame() ?? "");
    const weights = frame.split("\n").find((row) => row.includes("model weights"));
    expect(weights).toContain("waiting");
    expect(frame).toContain("6%");
  });

  it("surfaces a failed pull instead of a silent stall", () => {
    // The state a real failure leaves behind: `local_models_pull_failed`
    // nulls the pull and parks the message on the panel's error line.
    const view = mount(step({ pull: null, pullError: "connection reset" }));
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("connection reset");
    expect(frame).toContain("download failed");
    // No claim of a download that is not running.
    expect(frame).not.toContain("starting");
    expect(frame).not.toContain("keeps running");
    expect(frame).not.toContain("░");
    // The cloud offer survives the failure — it is the working way out.
    expect(frame).toContain("press c");
    // So does the skip exit, honest about what it leaves behind.
    expect(frame).toContain("without a local model");
    expect(frame).toContain("press s");
  });

  it("offers the skip exit while the download runs, top bar promise included", () => {
    const view = mount(step());
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Or skip the wait");
    expect(frame).toContain("progress shows in the top bar");
    expect(frame).toContain("press s");
  });

  it("keeps the skip exit even when there is no cloud left to offer", () => {
    const view = mount(step({ offerCloudMeanwhile: false }));
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).not.toContain("press c");
    expect(frame).toContain("press s");
  });

  it("estimates a rate once a second sample arrives", async () => {
    const view = mount(step({ pull: pull({ transferredBytes: 1_000_000_000 }) }));
    expect(strip(view.lastFrame() ?? "")).toContain("estimating");
    view.rerender(step({ pull: pull({ transferredBytes: 1_400_000_000 }) }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(strip(view.lastFrame() ?? "")).toMatch(/\/s /);
  });
});

describe("countOnboardingDownloadBlockRows", () => {
  /**
   * The count is what the ambient field's budget subtracts from the
   * placement, so the step's share is pinned against the drawn frame
   * rather than trusted: the count minus the header rows (3 for the sm
   * mark, 2 for xs — pinned by the full-surface frame test) and the gap
   * under the header must equal the lines the step actually renders.
   */
  it("counts the step's own rows the way the frame draws them", () => {
    const view = mount(step());
    const lines = strip(view.lastFrame() ?? "").split("\n");
    // headline + margin + 2 bars + margin + rate + 2-row margin + offer
    // + the skip row's margin and two lines
    expect(lines.length).toBe(13);
    const withMark = countOnboardingDownloadBlockRows({ mark: "sm", offerCloud: true });
    const noMark = countOnboardingDownloadBlockRows({ mark: "xs", offerCloud: true });
    expect(withMark).toBe(lines.length + 3 + 1);
    expect(noMark).toBe(lines.length + 2 + 1);
  });

  it("gives the offer's four rows back once it is spent", () => {
    const withOffer = countOnboardingDownloadBlockRows({ mark: "sm", offerCloud: true });
    const without = countOnboardingDownloadBlockRows({ mark: "sm", offerCloud: false });
    expect(withOffer - without).toBe(4);
    // The skip row stays: 6 progress rows plus its margin and two lines.
    const view = mount(step({ offerCloudMeanwhile: false }));
    expect(strip(view.lastFrame() ?? "").split("\n").length).toBe(9);
  });
});
