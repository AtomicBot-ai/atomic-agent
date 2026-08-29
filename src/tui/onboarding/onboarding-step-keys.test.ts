import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { arrowKey, plainKey, returnKey } from "../mouse/synthetic-key.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import {
  handleOnboardingStepKey,
  onboardingPickRows,
} from "./onboarding-step-keys.js";
import { createOnboardingState, type OnboardingStep } from "./onboarding-state.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

function escKey(): Key {
  return { ...returnKey(), return: false, escape: true };
}

function stateAt(
  step: OnboardingStep,
  over: Partial<TuiState["onboarding"] & object> = {},
): TuiState {
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step,
    ...over,
  };
  return { ...createInitialTuiState(fakeSession(), 50), onboarding };
}

interface Driven {
  actions: TuiAction[];
  pulls: string[];
  handle(input: string, key: Key): boolean;
}

function drive(state: TuiState): Driven {
  const actions: TuiAction[] = [];
  const pulls: string[] = [];
  return {
    actions,
    pulls,
    handle: (input, key) =>
      handleOnboardingStepKey(input, key, {
        state,
        dispatch: (action) => actions.push(action),
        callbacks: {
          onLocalModelsPullRequested: (modelId) => pulls.push(modelId),
        },
      }),
  };
}

/**
 * The same table the per-step `useInput` blocks used to hold, exercised
 * through the router the keyboard AND the mouse now share — so these
 * are also the click tests' ground truth for what activation means.
 */
describe("handleOnboardingStepKey", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-step-keys-"));
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

  it("declines the steps whose keys belong to someone else", () => {
    for (const step of ["intro", "local_hf_ref", "custom_chat_url", "finished"] as const) {
      const driven = drive(stateAt(step));
      expect(driven.handle("", returnKey())).toBe(false);
      expect(driven.actions).toEqual([]);
    }
  });

  it("choose: Enter opens the branch under the cursor", () => {
    const driven = drive(stateAt("choose", { cursor: 1 }));
    expect(driven.handle("", returnKey())).toBe(true);
    expect(driven.actions.map((action) => action.type)).toEqual([
      "providers_wizard_opened",
      "onboarding_step_set",
    ]);
    expect(driven.actions[1]).toMatchObject({ step: "cloud" });
  });

  it("choose: Esc is a recorded skip", () => {
    const driven = drive(stateAt("choose"));
    expect(driven.handle("", escKey())).toBe(true);
    expect(driven.actions).toContainEqual({
      type: "onboarding_finished",
      outcome: "skipped",
    });
  });

  it("choose: an arrow moves the cursor exactly as before", () => {
    const driven = drive(stateAt("choose"));
    expect(driven.handle("", arrowKey("down"))).toBe(true);
    expect(driven.actions).toContainEqual({ type: "onboarding_cursor_moved", delta: 1 });
  });

  it("local_pick: Enter on the pinned row opens the Hugging Face branch", () => {
    const rows = onboardingPickRows();
    const hfIndex = rows.findIndex((row) => row.kind === "hugging_face");
    expect(hfIndex).toBeGreaterThan(-1);
    const driven = drive(stateAt("local_pick", { cursor: hfIndex }));
    expect(driven.handle("", returnKey())).toBe(true);
    expect(driven.actions).toContainEqual({
      type: "onboarding_step_set",
      step: "local_hf_ref",
    });
  });

  it("local_pick: Enter on a curated row commits to it and starts the pull", () => {
    const rows = onboardingPickRows();
    const first = rows[0];
    if (first?.kind !== "model") throw new Error("no curated rows in the catalog");
    const driven = drive(stateAt("local_pick", { cursor: 0 }));
    expect(driven.handle("", returnKey())).toBe(true);
    expect(driven.actions).toContainEqual({
      type: "onboarding_local_model_picked",
      modelId: first.pick.id,
    });
    expect(driven.pulls).toEqual([first.pick.id]);
  });

  it("local_download: c opens the meanwhile wizard, ctrl+c does not", () => {
    const driven = drive(stateAt("local_download"));
    expect(driven.handle("c", { ...plainKey(), ctrl: true })).toBe(false);
    expect(driven.actions).toEqual([]);
    expect(driven.handle("c", plainKey())).toBe(true);
    expect(driven.actions.map((action) => action.type)).toEqual([
      "providers_wizard_opened",
      "onboarding_cloud_meanwhile_opened",
    ]);
  });

  it("local_download: s skips straight to the agent, without the second pitch", () => {
    const driven = drive(stateAt("local_download"));
    expect(driven.handle("s", { ...plainKey(), ctrl: true })).toBe(false);
    expect(driven.actions).toEqual([]);
    expect(driven.handle("s", plainKey())).toBe(true);
    // One action, flagged: the finished effect must not raise the
    // propose-second screen on this exit — the download screen already
    // made the cloud pitch itself.
    expect(driven.actions).toEqual([
      { type: "onboarding_finished", outcome: "local", skipSecondOffer: true },
    ]);
  });

  it("wait_or_jump: the row count tracks the pull, retry included", () => {
    const failedState = stateAt("wait_or_jump", { localModelId: "gemma-4-e4b" });
    failedState.localModelsPanel = {
      ...failedState.localModelsPanel,
      pull: null,
      errorLine: "connection reset",
    };
    const driven = drive(failedState);
    expect(driven.handle("j", plainKey())).toBe(true);
    expect(driven.actions).toContainEqual({
      type: "onboarding_cursor_moved",
      delta: 1,
      length: 3,
    });
    // Enter on the retry row re-runs the same pull.
    failedState.onboarding!.cursor = 2;
    expect(driven.handle("", returnKey())).toBe(true);
    expect(driven.pulls).toEqual(["gemma-4-e4b"]);
  });

  it("local_hf_pick: Enter writes the catalog entry and starts the pull", () => {
    const GB = 1024 * 1024 * 1024;
    const driven = drive(
      stateAt("local_hf_pick", {
        hfRepo: {
          repoId: "unsloth/Qwen3-0.6B-GGUF",
          revision: "main",
          choices: [
            {
              path: "Qwen3-0.6B-Q4_K_M.gguf",
              filename: "Qwen3-0.6B-Q4_K_M.gguf",
              sizeBytes: 0.38 * GB,
              fileSizeGb: 0.38,
              sizeLabel: "387 MB",
            },
          ],
          mmproj: null,
          hidden: null,
        },
      }),
    );
    expect(driven.handle("", returnKey())).toBe(true);
    const picked = driven.actions.find(
      (action) => action.type === "onboarding_local_model_picked",
    );
    expect(picked).toBeDefined();
    // The pull is handed the id the catalog write minted.
    expect(driven.pulls).toHaveLength(1);
    expect(driven.pulls[0]).toContain("custom");
  });

  it("cloud: routes into the wizard's own key handler", () => {
    const state = stateAt("cloud");
    state.providersPanel = {
      ...state.providersPanel,
      wizard: createProvidersWizardState("add"),
    };
    const driven = drive(state);
    expect(driven.handle("", arrowKey("down"))).toBe(true);
    expect(driven.actions.map((action) => action.type)).toEqual([
      "providers_wizard_updated",
    ]);
  });

  it("cloud: declines when no wizard is mounted", () => {
    const driven = drive(stateAt("cloud"));
    expect(driven.handle("", arrowKey("down"))).toBe(false);
  });
});
