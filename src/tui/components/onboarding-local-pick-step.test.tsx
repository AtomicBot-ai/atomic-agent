import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { LOCAL_MODELS_CATALOG } from "../../local-llm/models-catalog.js";
import {
  buildLocalModelPicks,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import {
  LOCAL_PICK_WINDOW,
  OnboardingLocalPickStep,
  windowLocalPicks,
} from "./onboarding-local-pick-step.js";

const FULL = computeOnboardingFit({ columns: 100, rows: 30 });
const MINIMAL = computeOnboardingFit({ columns: 60, rows: 14 });

const UNCENSORED_ID = "qwen-3.8-27b-uncensored";

function frameAt(cursor: number, ramGb: number, fit = FULL): string {
  const picks = orderLocalModelPicks(buildLocalModelPicks(ramGb, LOCAL_MODELS_CATALOG));
  const view = render(
    <OnboardingLocalPickStep picks={picks} cursor={cursor} ramGb={ramGb} fit={fit} />,
  );
  const frame = (view.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  view.unmount();
  return frame;
}

describe("the uncensored row on the first-run pick screen", () => {
  // The catalog outgrew the window, so the pinned-last uncensored row
  // starts below the fold — the trailing counter is what says so, and
  // the window follows the cursor until the row is on screen.
  it("is reachable by scrolling even though it starts below the fold", () => {
    const picks = orderLocalModelPicks(buildLocalModelPicks(16, LOCAL_MODELS_CATALOG));
    expect(picks.length).toBeGreaterThan(LOCAL_PICK_WINDOW);
    const atTop = windowLocalPicks(picks, 0);
    expect(atTop.visible.some((p) => p.id === UNCENSORED_ID)).toBe(false);
    expect(atTop.below).toBeGreaterThan(0);
    const atBottom = windowLocalPicks(picks, picks.length - 1);
    expect(atBottom.visible.at(-1)?.id).toBe(UNCENSORED_ID);
    expect(atBottom.below).toBe(0);
  });

  it("draws the warning tag once scrolled to, above the Hugging Face row", () => {
    const picks = orderLocalModelPicks(buildLocalModelPicks(16, LOCAL_MODELS_CATALOG));
    const frame = frameAt(picks.length - 1, 16);
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    const uncensoredLine = lines.findIndex((l) => l.includes(UNCENSORED_ID));
    const hfLine = lines.findIndex((l) => l.includes("Add a model from Hugging Face"));
    expect(uncensoredLine).toBeGreaterThan(-1);
    expect(lines[uncensoredLine]).toContain("Use at your own risk");
    // The last model row, with only the escape hatch below it.
    expect(hfLine).toBe(uncensoredLine + 1);
  });

  // The minimal tier drops descriptions but must never drop the warning.
  it("keeps the warning when the tier drops the row details", () => {
    const picks = orderLocalModelPicks(buildLocalModelPicks(8, LOCAL_MODELS_CATALOG));
    const frame = frameAt(picks.length - 1, 8, MINIMAL);
    expect(frame).toContain("Use at your own risk");
    // And the fit stays honest on a small host: 8 GB is under the 20 GB
    // minimum, so the row asks for the RAM it actually needs.
    expect(frame).toContain("needs 32 GB RAM");
  });
});
