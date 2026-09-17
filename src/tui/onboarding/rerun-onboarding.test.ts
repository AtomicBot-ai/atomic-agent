import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { returnKey } from "../mouse/synthetic-key.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { decideOnboarding } from "./needs-onboarding.js";
import { handleOnboardingStepKey } from "./onboarding-step-keys.js";
import {
  ONBOARDING_RERUN_RESET,
  reopenOnboarding,
} from "./rerun-onboarding.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const STAMP = "2026-09-01T10:00:00.000Z";

function escKey(): Key {
  return { ...returnKey(), return: false, escape: true };
}

describe("reopenOnboarding", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-rerun-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function stampEverything(): void {
    persistOnboardingState({
      completedAt: STAMP,
      introSeenAt: STAMP,
      skippedAt: STAMP,
      proposedSecondBackendAt: STAMP,
      localSetupSeenAt: STAMP,
      importOfferedAt: STAMP,
    });
  }

  function reopened(): TuiState {
    let state = createInitialTuiState(fakeSession(), 50);
    reopenOnboarding((action) => {
      state = reduceTuiState(state, action);
    });
    return state;
  }

  /** Feed one key through the flow's real router, folding what it dispatches. */
  function press(state: TuiState, input: string, key: Key): TuiState {
    let next = state;
    const dispatched: TuiAction[] = [];
    handleOnboardingStepKey(input, key, {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: {},
    });
    for (const action of dispatched) next = reduceTuiState(next, action);
    return next;
  }

  it("clears every onboarding stamp, the once-only offers included", () => {
    stampEverything();
    expect(decideOnboarding().needed).toBe(false);
    reopenOnboarding(() => {});
    expect(getConfig().tui.onboarding).toEqual(ONBOARDING_RERUN_RESET);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.tui.onboarding).toEqual(ONBOARDING_RERUN_RESET);
    // Nothing configured in this temp state dir, so with the stamps gone
    // the next launch reads as a fresh install again.
    expect(decideOnboarding()).toEqual({
      needed: true,
      reason: "fresh_install",
    });
  });

  it("opens the flow on its splash", () => {
    stampEverything();
    const dispatched: TuiAction[] = [];
    reopenOnboarding((action) => dispatched.push(action));
    expect(dispatched).toHaveLength(1);
    const [action] = dispatched;
    expect(action?.type).toBe("onboarding_set");
    if (action?.type !== "onboarding_set") return;
    expect(action.onboarding?.step).toBe("intro");
    expect(action.onboarding?.outcome).toBeNull();
    expect(action.onboarding?.chatUrl).toBe(getConfig().localModels.url);
  });

  it("leaves everything outside tui.onboarding byte-for-byte alone", () => {
    stampEverything();
    const path = getConfig().paths.userConfigFile;
    const before = JSON.parse(readFileSync(path, "utf8"));
    reopenOnboarding(() => {});
    const after = JSON.parse(readFileSync(path, "utf8"));
    const withoutStamps = (file: { tui: Record<string, unknown> }) => ({
      ...file,
      tui: { ...file.tui, onboarding: undefined },
    });
    expect(withoutStamps(after)).toEqual(withoutStamps(before));
  });

  it("marks a re-run of an onboarded install, not a first run that never finished", () => {
    stampEverything();
    const rerun = reopened().onboarding;
    expect(rerun?.rerun).toBe(true);
    // The reset above left this state dir looking fresh: opening setup
    // now is what the launch would have done anyway — a first run.
    const firstRun = reopened().onboarding;
    expect(firstRun?.rerun).toBe(false);
  });

  it("browsing the local branch and backing out keeps a custom endpoint working", () => {
    persistUserLocalModelsConfig({
      mode: "external",
      url: "http://192.168.1.50:9000",
    });
    stampEverything();
    resetConfigCache();
    expect(decideOnboarding().needed).toBe(false);

    let state = reopened();
    state = reduceTuiState(state, {
      type: "onboarding_step_set",
      step: "choose",
    });
    // Enter on row 0 — "Local models", where the cursor starts.
    state = press(state, "", returnKey());
    expect(state.onboarding?.step).toBe("local_pick");
    // Esc back to the choice, Esc again: the recorded skip.
    state = press(state, "", escKey());
    expect(state.onboarding?.step).toBe("choose");
    state = press(state, "", escKey());
    expect(state.onboarding?.step).toBe("finished");
    expect(state.onboarding?.outcome).toBe("skipped");

    resetConfigCache();
    expect(getConfig().localModels.mode).toBe("external");
    expect(getConfig().localModels.url).toBe("http://192.168.1.50:9000");
    // With the stamps cleared, only the endpoint keeps this install
    // counted as configured — it has to still read as one.
    expect(decideOnboarding()).toEqual({
      needed: false,
      reason: "backend_configured",
    });
  });
});
