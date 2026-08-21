import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { DownloadChip } from "./download-chip.js";
import { OnboardingWaitOrJumpStep } from "./onboarding-wait-or-jump-step.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

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

describe("DownloadChip", () => {
  it("names the model and its progress in one row", () => {
    const view = render(<DownloadChip pull={pull()} />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("gemma-4-e4b");
    expect(frame).toContain("61%");
    expect(frame.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
  });

  it("names the runtime rather than a model id during the backend pull", () => {
    const view = render(<DownloadChip pull={pull({ kind: "backend", modelId: "_backend" })} />);
    expect(strip(view.lastFrame() ?? "")).toContain("llama.cpp");
  });
});

describe("OnboardingWaitOrJumpStep", () => {
  it("shows both outcomes and what each one costs", () => {
    const view = render(
      <OnboardingWaitOrJumpStep pull={pull()} cloudLabel="Cloud model ready" cursor={0} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Cloud model ready");
    expect(frame).toContain("gemma-4-e4b");
    expect(frame).toContain("Start using the agent now");
    expect(frame).toContain("top bar");
    expect(frame).toContain("Wait here until it finishes");
  });

  it("defaults to jumping", () => {
    const view = render(
      <OnboardingWaitOrJumpStep pull={pull()} cloudLabel="Cloud model ready" cursor={0} />,
    );
    const line = strip(view.lastFrame() ?? "")
      .split("\n")
      .find((row) => row.includes("Start using the agent now"));
    expect(line?.trimStart().startsWith("\u203a")).toBe(true);
  });
});
