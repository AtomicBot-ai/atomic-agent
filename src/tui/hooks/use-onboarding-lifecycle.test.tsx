import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createOnboardingState,
  type OnboardingOutcome,
  type OnboardingStep,
  type OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import { useOnboardingLifecycle } from "./use-onboarding-lifecycle.js";

/**
 * Drives only the step-reporting effect. `onFinished` is left off and
 * `dispatch` is a sink, so the settle branch cannot run its persistence
 * — this pins the analytics contract on its own.
 */
function Harness(props: {
  step: OnboardingStep;
  outcome?: OnboardingOutcome;
  onStep(step: string, outcome?: string): void;
}): React.ReactElement {
  const onboarding: OnboardingUiState = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step: props.step,
    outcome: props.outcome ?? null,
  };
  useOnboardingLifecycle({
    onboarding,
    dispatch: () => {},
    onStep: props.onStep,
  });
  return <></>;
}

describe("useOnboardingLifecycle step reporting", () => {
  it("reports the step the flow is on", () => {
    const onStep = vi.fn();
    render(<Harness step="choose" onStep={onStep} />);
    expect(onStep).toHaveBeenCalledWith("choose");
  });

  it("reports each step once across re-renders of the same step", () => {
    const onStep = vi.fn();
    const view = render(<Harness step="choose" onStep={onStep} />);
    view.rerender(<Harness step="choose" onStep={onStep} />);
    view.rerender(<Harness step="choose" onStep={onStep} />);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("reports each new step the flow moves to", () => {
    const onStep = vi.fn();
    const view = render(<Harness step="intro" onStep={onStep} />);
    view.rerender(<Harness step="choose" onStep={onStep} />);
    view.rerender(<Harness step="cloud" onStep={onStep} />);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual([
      "intro",
      "choose",
      "cloud",
    ]);
  });

  it("attaches the outcome on the terminal step", () => {
    const onStep = vi.fn();
    render(<Harness step="finished" outcome="cloud" onStep={onStep} />);
    expect(onStep).toHaveBeenCalledWith("finished", "cloud");
  });

  it("does not double-count `finished` when the second-backend offer sends the flow back through it", () => {
    const onStep = vi.fn();
    const view = render(
      <Harness step="finished" outcome="local" onStep={onStep} />,
    );
    // The offer intercepts, the flow leaves `finished`, then settles
    // through it a second time with the same outcome.
    view.rerender(<Harness step="propose_second" onStep={onStep} />);
    view.rerender(<Harness step="finished" outcome="local" onStep={onStep} />);
    const finishes = onStep.mock.calls.filter((c) => c[0] === "finished");
    expect(finishes).toHaveLength(1);
  });

  it("still reports the outcome when `finished` first renders without one", () => {
    const onStep = vi.fn();
    const view = render(<Harness step="finished" onStep={onStep} />);
    view.rerender(<Harness step="finished" outcome="skipped" onStep={onStep} />);
    expect(onStep).toHaveBeenCalledWith("finished", "skipped");
  });
});
