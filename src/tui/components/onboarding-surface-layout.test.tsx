import { Box } from "ink";
import { render } from "ink-testing-library";
import React, { type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ROOT_PADDING_LEFT } from "../layout.js";
import { buildLocalModelPicks, orderLocalModelPicks } from "../onboarding/local-model-picks.js";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import { measureOnboardingChooseStep, OnboardingChooseStep } from "./onboarding-choose-step.js";
import {
  measureOnboardingDownloadStep,
  OnboardingDownloadStep,
} from "./onboarding-download-step.js";
import { measureOnboardingHeader, OnboardingHeader } from "./onboarding-header.js";
import {
  measureOnboardingLocalPickStep,
  OnboardingLocalPickStep,
} from "./onboarding-local-pick-step.js";
import {
  measureOnboardingProposeStep,
  OnboardingProposeStep,
} from "./onboarding-propose-step.js";
import { measureOnboardingUrlStep, OnboardingUrlStep } from "./onboarding-url-step.js";
import { layOutOnboardingSurface } from "./onboarding-surface-layout.js";
import {
  measureOnboardingWaitOrJumpStep,
  OnboardingWaitOrJumpStep,
} from "./onboarding-wait-or-jump-step.js";

/** `ink-testing-library` renders into a fixed 100-column stdout. */
const TEST_COLUMNS = 100;

const FULL = computeOnboardingFit({ columns: 100, rows: 30 });
const MINIMAL = computeOnboardingFit({ columns: 60, rows: 14 });
const PICKS = orderLocalModelPicks(buildLocalModelPicks(16));

function drawnLines(element: ReactElement, width?: number): string[] {
  const view = render(
    width === undefined ? element : <Box width={width}>{element}</Box>,
  );
  const frame = (view.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  view.unmount();
  return frame.split("\n");
}

function widestDrawn(lines: readonly string[]): number {
  return lines.reduce((max, line) => Math.max(max, line.trimEnd().length), 0);
}

/**
 * Every measure is checked against the step it claims to measure, by
 * rendering that step and reading the widest line back off the frame.
 * A measure that drifts from its own copy is the one failure mode this
 * whole mechanism has, and only the render can catch it.
 *
 * `exact` is off for the screens that deliberately reserve room for
 * counters that have not arrived yet — there the measure is an upper
 * bound, and the test says so rather than pinning the slack. Exact
 * cases are compared against the test terminal's own width as well: a
 * model row carrying a long description runs past 100 columns, and the
 * frame reports the truncated row rather than the row that was asked
 * for.
 */
const cases: { name: string; measured: number; element: ReactElement; exact: boolean }[] = [
  {
    name: "the brand lockup with its mark",
    measured: measureOnboardingHeader("setup · step 1 of 2", "sm"),
    element: <OnboardingHeader subtitle="setup · step 1 of 2" mark="sm" />,
    exact: true,
  },
  {
    name: "the brand lockup with the two-row XS sign",
    measured: measureOnboardingHeader("setup · step 1 of 2", "xs"),
    element: <OnboardingHeader subtitle="setup · step 1 of 2" mark="xs" />,
    exact: true,
  },
  {
    name: "the backend choice at full size",
    measured: measureOnboardingChooseStep(FULL),
    element: <OnboardingChooseStep cursor={0} fit={FULL} />,
    exact: true,
  },
  {
    name: "the backend choice stripped to its labels",
    measured: measureOnboardingChooseStep(MINIMAL),
    element: <OnboardingChooseStep cursor={1} fit={MINIMAL} />,
    exact: true,
  },
  {
    name: "the model list",
    measured: measureOnboardingLocalPickStep({
      picks: PICKS,
      cursor: 0,
      ramGb: 16,
      fit: FULL,
    }),
    element: <OnboardingLocalPickStep picks={PICKS} cursor={0} ramGb={16} fit={FULL} />,
    exact: true,
  },
  {
    name: "the model list scrolled to its last row",
    measured: measureOnboardingLocalPickStep({
      picks: PICKS,
      cursor: PICKS.length - 1,
      ramGb: 8,
      fit: MINIMAL,
    }),
    element: (
      <OnboardingLocalPickStep
        picks={PICKS}
        cursor={PICKS.length - 1}
        ramGb={8}
        fit={MINIMAL}
      />
    ),
    exact: true,
  },
  {
    name: "the second-backend offer",
    measured: measureOnboardingProposeStep({
      offer: "local",
      configuredLabel: "Cloud model ready",
    }),
    element: (
      <OnboardingProposeStep offer="local" configuredLabel="Cloud model ready" cursor={0} />
    ),
    exact: true,
  },
  {
    name: "the chat endpoint box",
    measured: measureOnboardingUrlStep("chat"),
    element: (
      <OnboardingUrlStep
        kind="chat"
        value=""
        busy={false}
        error={null}
        onChange={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    ),
    exact: true,
  },
  {
    name: "the embedding endpoint box",
    measured: measureOnboardingUrlStep("embedding"),
    element: (
      <OnboardingUrlStep
        kind="embedding"
        value=""
        busy={false}
        error={null}
        onChange={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    ),
    exact: true,
  },
  {
    name: "the wait-or-jump question once the pull has landed",
    measured: measureOnboardingWaitOrJumpStep({
      pull: null,
      pullError: null,
      cloudLabel: "Cloud model ready",
      modelLabel: "qwen3-4b-instruct",
      fit: FULL,
    }),
    element: (
      <OnboardingWaitOrJumpStep
        pull={null}
        pullError={null}
        cloudLabel="Cloud model ready"
        modelLabel="qwen3-4b-instruct"
        cursor={0}
        fit={FULL}
      />
    ),
    exact: true,
  },
  {
    name: "the download, which reserves room for its counters",
    measured: measureOnboardingDownloadStep({
      modelLabel: "qwen3-4b-instruct",
      offerCloudMeanwhile: true,
    }),
    element: (
      <OnboardingDownloadStep
        pull={null}
        pullError={null}
        modelLabel="qwen3-4b-instruct"
        offerCloudMeanwhile
      />
    ),
    exact: false,
  },
];

describe("the download step's placement", () => {
  // The regression this pins: `local_download` used to answer the
  // measure with the whole terminal, so `placeOnboardingBlock` clamped
  // `left` to zero and the one screen sat hard against the margin while
  // every other step centred. The measure the width test above pins is
  // now the one production actually uses.
  it("centres the download block instead of handing it the terminal", () => {
    const measured = measureOnboardingDownloadStep({
      modelLabel: "qwen3-4b-instruct",
      offerCloudMeanwhile: true,
    });
    const placement = layOutOnboardingSurface({
      columns: 100,
      rows: 30,
      step: "local_download",
      fit: FULL,
      subtitle: "local models · downloading",
      picks: PICKS,
      cursor: 0,
      ramGb: 16,
      offer: null,
      configuredLabel: "Backend ready",
      modelLabel: "qwen3-4b-instruct",
      offerCloudMeanwhile: true,
      pull: null,
      cloudLabel: "Cloud model ready",
      hfRepo: null,
    });
    expect(measured).toBeLessThan(98);
    expect(placement.width).toBe(measured);
    expect(placement.left).toBe(Math.floor((100 - measured) / 2) - ROOT_PADDING_LEFT);
    expect(placement.left).toBeGreaterThan(0);
  });
});

describe("the per-step block measures", () => {
  for (const testCase of cases) {
    it(`measures ${testCase.name}`, () => {
      const drawn = widestDrawn(drawnLines(testCase.element));
      expect(drawn).toBeGreaterThan(0);
      if (testCase.exact) expect(Math.min(testCase.measured, TEST_COLUMNS)).toBe(drawn);
      else expect(testCase.measured).toBeGreaterThanOrEqual(drawn);
    });

    // The failure the width check alone cannot see: a step whose lines
    // carry trailing pad cells measures narrow but draws wide, and once
    // the block is pinned to `width={measured}` Ink wraps the invisible
    // cells into extra rows instead of clipping them. Same line count
    // pinned and free means nothing wrapped inside the measure.
    it(`draws ${testCase.name} without wrapping inside its own measure`, () => {
      const free = drawnLines(testCase.element);
      const pinned = drawnLines(
        testCase.element,
        Math.min(testCase.measured, TEST_COLUMNS),
      );
      expect(pinned.length).toBe(free.length);
    });
  }
});
