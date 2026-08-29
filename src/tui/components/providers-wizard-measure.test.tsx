import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import {
  KIND_OPTIONS,
  measureProvidersWizard,
} from "./providers-wizard-measure.js";
import { ProvidersWizard } from "./providers-wizard.js";

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

/**
 * The measure is held against the rendered wizard, so the number the
 * onboarding surface centres on cannot drift from what the wizard
 * draws — the same contract every other setup step's measure test
 * makes, which is what replaced the hardcoded 96-column guess.
 */
describe("measureProvidersWizard", () => {
  const widestOption = KIND_OPTIONS.reduce((a, b) =>
    b.label.length > a.label.length ? b : a,
  );

  it("gives the widest provider row exactly the room it draws in", () => {
    const width = measureProvidersWizard();
    // Window the pick list around the widest row so it is on screen.
    const wizard = {
      ...createProvidersWizardState("add"),
      cursor: KIND_OPTIONS.findIndex((o) => o.label === widestOption.label),
    };
    const view = render(
      <Box width={width}>
        <ProvidersWizard wizard={wizard} />
      </Box>,
    );
    const lines = strip(view.lastFrame() ?? "").split("\n");
    view.unmount();
    // Un-truncated: the row that decides the measure survives it whole.
    expect(lines.some((line) => line.includes(widestOption.label))).toBe(true);
    // And the box spends exactly the measured width, no more.
    const widest = lines.reduce(
      (max, line) => Math.max(max, line.trimEnd().length),
      0,
    );
    expect(widest).toBe(width);
  });

  it("stays inside the 100-column terminal the flow asks for", () => {
    // The cap the guess used to encode, now a consequence of measuring:
    // everything deterministic fitted a 100-column terminal before this
    // slice, and the measure must keep saying so.
    expect(measureProvidersWizard()).toBeLessThanOrEqual(100);
  });
});
