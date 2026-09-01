import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import type { DetectedImportAgent } from "../../import/index.js";
import {
  createOnboardingState,
  type OnboardingOutcome,
  type OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import type { TuiAction } from "../tui-action.js";
import { useOnboardingLifecycle } from "./use-onboarding-lifecycle.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

const ONE_AGENT: DetectedImportAgent[] = [
  { id: "hermes", label: "Hermes", dir: "/tmp/h" },
];

function Harness(props: {
  outcome: OnboardingOutcome;
  skipSecondOffer?: boolean;
  detectAgents(): DetectedImportAgent[];
  dispatch(action: TuiAction): void;
}): React.ReactElement {
  const onboarding: OnboardingUiState = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step: "finished",
    outcome: props.outcome,
    skipSecondOffer: props.skipSecondOffer ?? false,
  };
  useOnboardingLifecycle({
    onboarding,
    dispatch: props.dispatch,
    detectAgents: props.detectAgents,
  });
  return <></>;
}

/**
 * The settle effect's import intercept. Outcome `custom` throughout,
 * because it is the one outcome `decideSecondBackendOffer` never
 * intercepts first — these tests pin the *import* offer's contract.
 */
describe("useOnboardingLifecycle import offer", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-import-"));
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[STATE_DIR_ENV];
    } else {
      process.env[STATE_DIR_ENV] = originalEnv;
    }
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("raises the import step instead of settling when agents exist", () => {
    const actions: TuiAction[] = [];
    render(
      <Harness
        outcome="custom"
        detectAgents={() => ONE_AGENT}
        dispatch={(a) => actions.push(a)}
      />,
    );
    expect(actions).toEqual([
      {
        type: "onboarding_import_opened",
        agents: [{ id: "hermes", label: "Hermes", dir: "/tmp/h", enabled: true }],
      },
    ]);
    // Offered once, stamped now; the flow itself is not yet retired.
    expect(getConfig().tui.onboarding.importOfferedAt).not.toBeNull();
    expect(getConfig().tui.onboarding.completedAt).toBeNull();
  });

  it("settles once the offer was already made", () => {
    render(
      <Harness outcome="custom" detectAgents={() => ONE_AGENT} dispatch={() => {}} />,
    );
    const actions: TuiAction[] = [];
    render(
      <Harness
        outcome="custom"
        detectAgents={() => ONE_AGENT}
        dispatch={(a) => actions.push(a)}
      />,
    );
    expect(actions).toContainEqual({ type: "onboarding_set", onboarding: null });
    expect(getConfig().tui.onboarding.completedAt).not.toBeNull();
  });

  it("settles straight through when nothing is detected", () => {
    const actions: TuiAction[] = [];
    render(
      <Harness outcome="custom" detectAgents={() => []} dispatch={(a) => actions.push(a)} />,
    );
    expect(actions).toContainEqual({ type: "onboarding_set", onboarding: null });
    // An offer that never appeared must not claim its once-only slot.
    expect(getConfig().tui.onboarding.importOfferedAt).toBeNull();
  });

  it("never pitches an operator who skipped setup", () => {
    const detect = vi.fn(() => ONE_AGENT);
    const actions: TuiAction[] = [];
    render(
      <Harness outcome="skipped" detectAgents={detect} dispatch={(a) => actions.push(a)} />,
    );
    expect(detect).not.toHaveBeenCalled();
    expect(actions).toContainEqual({ type: "onboarding_set", onboarding: null });
    expect(getConfig().tui.onboarding.skippedAt).not.toBeNull();
  });

  it("honours the download skip's straight-to-the-agent promise", () => {
    const detect = vi.fn(() => ONE_AGENT);
    const actions: TuiAction[] = [];
    render(
      <Harness
        outcome="local"
        skipSecondOffer
        detectAgents={detect}
        dispatch={(a) => actions.push(a)}
      />,
    );
    expect(detect).not.toHaveBeenCalled();
    expect(actions).toContainEqual({ type: "onboarding_set", onboarding: null });
    expect(getConfig().tui.onboarding.importOfferedAt).toBeNull();
  });
});
