import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { OnboardingDownloadStep } from "./onboarding-download-step.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

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

describe("OnboardingDownloadStep", () => {
  it("says what is happening before the first progress event lands", () => {
    const view = render(<OnboardingDownloadStep pull={null} modelLabel="gemma-4-e4b" />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Downloading gemma-4-e4b");
    expect(frame).toContain("starting");
  });

  it("reports bytes and percent for the phase in flight", () => {
    const view = render(<OnboardingDownloadStep pull={pull()} modelLabel="gemma-4-e4b" />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("model weights");
    expect(frame).toContain("38%");
    expect(frame).toContain("1.6 GB / 4.2 GB");
  });

  it("shows the runtime phase as done once the weights start", () => {
    const view = render(<OnboardingDownloadStep pull={pull()} modelLabel="gemma-4-e4b" />);
    const line = strip(view.lastFrame() ?? "")
      .split("\n")
      .find((row) => row.includes("llama.cpp runtime"));
    expect(line).toContain("done");
  });

  it("marks the weights as waiting while the runtime is still coming down", () => {
    const view = render(
      <OnboardingDownloadStep
        pull={pull({ kind: "backend", modelId: "_backend", percent: 6 })}
        modelLabel="gemma-4-e4b"
      />,
    );
    const frame = strip(view.lastFrame() ?? "");
    const weights = frame.split("\n").find((row) => row.includes("model weights"));
    expect(weights).toContain("waiting");
    expect(frame).toContain("6%");
  });

  it("surfaces a failed pull instead of a silent stall", () => {
    const view = render(
      <OnboardingDownloadStep
        pull={pull({ error: "connection reset" })}
        modelLabel="gemma-4-e4b"
      />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("connection reset");
  });

  it("estimates a rate once a second sample arrives", async () => {
    const view = render(
      <OnboardingDownloadStep pull={pull({ transferredBytes: 1_000_000_000 })} modelLabel="m" />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("estimating");
    view.rerender(
      <OnboardingDownloadStep pull={pull({ transferredBytes: 1_400_000_000 })} modelLabel="m" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(strip(view.lastFrame() ?? "")).toMatch(/\/s /);
  });
});
