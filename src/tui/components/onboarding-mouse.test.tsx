import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import {
  createOnboardingState,
  type OnboardingStep,
} from "../onboarding/onboarding-state.js";
import { onboardingPickRows } from "../onboarding/onboarding-step-keys.js";
import { visibleKindRows } from "../providers/providers-wizard-phases.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { OnboardingScreen } from "./onboarding-screen.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A pull in flight, for the steps that draw a bar. */
const PULL = {
  kind: "chat",
  modelId: "gemma-4-e4b",
  label: "Gemma 4 E4B",
  percent: 61,
  transferredBytes: 2_600_000_000,
  totalBytes: 4_220_000_000,
  error: null,
} as const;

function mouseEvent(over: Partial<TuiMouseEvent>): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x: 0,
    y: 0,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  };
}

interface Mounted {
  frame(): string;
  actions: TuiAction[];
  pulls: string[];
  registry: MouseTargetRegistry;
  stdin: { write(data: string): void };
  unmount(): void;
}

function mount(
  step: OnboardingStep,
  over: Partial<NonNullable<TuiState["onboarding"]>> = {},
  patchState: (state: TuiState) => void = () => {},
): Mounted {
  const actions: TuiAction[] = [];
  const pulls: string[] = [];
  const registry = new MouseTargetRegistry();
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step,
    ...over,
  };
  const state = { ...createInitialTuiState(fakeSession(), 50), onboarding };
  patchState(state);
  const dispatch = (action: TuiAction): void => {
    actions.push(action);
  };
  const callbacks: TuiAppCallbacks = {
    onLocalModelsPullRequested: (modelId) => pulls.push(modelId),
  };
  const view = render(
    <MouseProvider
      registry={registry}
      dispatch={dispatch}
      callbacks={callbacks}
      getState={() => state}
    >
      <OnboardingScreen
        state={state}
        onboarding={onboarding}
        dispatch={dispatch}
        callbacks={callbacks}
      />
    </MouseProvider>,
  );
  return {
    frame: () => strip(view.lastFrame() ?? ""),
    actions,
    pulls,
    registry,
    stdin: view.stdin,
    unmount: view.unmount,
  };
}

/** Screen cell of `label`'s first character, off the rendered frame. */
function pointOf(view: Mounted, label: string): { x: number; y: number } {
  const lines = view.frame().split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(label);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${label}" is not on screen:\n${view.frame()}`);
}

/**
 * Ink commits on its own throttle and targets register in effects after
 * the commit, so the surface is not clickable for a frame or two.
 * Row targets and the whole-surface backstop register in the same
 * commit (children's effects run first), so the first CLAIMED event
 * already saw every target — retries of an unclaimed one cannot land
 * twice.
 */
async function sendUntilClaimed(
  view: Mounted,
  label: string,
  over: Partial<TuiMouseEvent> = {},
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const point = pointOf(view, label);
    if (view.registry.dispatch(mouseEvent({ ...point, ...over }))) return;
    await delay(25);
  }
  throw new Error(`the surface never claimed an event at "${label}"`);
}

describe("onboarding mouse", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-mouse-"));
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

  it("choose: a click on an unselected row moves the cursor there", async () => {
    const view = mount("choose");
    await sendUntilClaimed(view, "Cloud models");
    expect(view.actions).toEqual([
      { type: "onboarding_cursor_set", cursor: 1 },
    ]);
    view.unmount();
  });

  it("choose: a click on the selected row activates it, exactly like Enter", async () => {
    const view = mount("choose", { cursor: 1 });
    await sendUntilClaimed(view, "Cloud models");
    // The same two actions the keyboard's Enter dispatches on this row.
    expect(view.actions.map((action) => action.type)).toEqual([
      "providers_wizard_opened",
      "onboarding_step_set",
    ]);
    expect(view.actions[1]).toMatchObject({ step: "cloud" });
    view.unmount();
  });

  it("choose: a wheel notch walks the list and never reaches the chat behind", async () => {
    const view = mount("choose");
    await sendUntilClaimed(view, "Local models", {
      kind: "wheel",
      button: "none",
      wheel: "down",
    });
    expect(view.actions).toContainEqual({ type: "onboarding_cursor_moved", delta: 1 });
    // Claimed at the flow's layer, so the app's viewport-wide wheel
    // target — the one that scrolls the invisible transcript — is never
    // consulted; nothing chat-shaped may leak out of the flow.
    expect(view.actions.every((action) => action.type !== "chat_scrolled")).toBe(true);
    view.unmount();
  });

  it("local_pick: clicking the pinned Hugging Face row selects, then opens it", async () => {
    const hfIndex = onboardingPickRows().findIndex(
      (row) => row.kind === "hugging_face",
    );
    const unselected = mount("local_pick", { cursor: 0 });
    await sendUntilClaimed(unselected, "Add a model from Hugging Face");
    expect(unselected.actions).toEqual([
      { type: "onboarding_cursor_set", cursor: hfIndex },
    ]);
    unselected.unmount();

    const selected = mount("local_pick", { cursor: hfIndex });
    await sendUntilClaimed(selected, "Add a model from Hugging Face");
    expect(selected.actions).toContainEqual({
      type: "onboarding_step_set",
      step: "local_hf_ref",
    });
    selected.unmount();
  });

  it("wait_or_jump: click selects a row, click again leaves for the agent", async () => {
    const select = mount(
      "wait_or_jump",
      { localModelId: "gemma-4-e4b" },
      (state) => {
        state.localModelsPanel = { ...state.localModelsPanel, pull: { ...PULL } };
      },
    );
    await sendUntilClaimed(select, "Add another cloud provider");
    expect(select.actions).toEqual([
      { type: "onboarding_cursor_set", cursor: 1 },
    ]);
    select.unmount();

    const activate = mount(
      "wait_or_jump",
      { localModelId: "gemma-4-e4b" },
      (state) => {
        state.localModelsPanel = { ...state.localModelsPanel, pull: { ...PULL } };
      },
    );
    await sendUntilClaimed(activate, "Start using the agent now");
    expect(activate.actions).toContainEqual({
      type: "onboarding_finished",
      outcome: "cloud",
    });
    activate.unmount();
  });

  it("propose_second: the rows answer to clicks like every other list", async () => {
    const view = mount("propose_second", { offer: "local" });
    await sendUntilClaimed(view, "Skip — take me to the agent");
    expect(view.actions).toEqual([
      { type: "onboarding_cursor_set", cursor: 1 },
    ]);
    view.unmount();
  });

  it("download: clicking the offer block sends the c it advertises", async () => {
    const view = mount(
      "local_download",
      { localModelId: "gemma-4-e4b" },
      (state) => {
        state.localModelsPanel = { ...state.localModelsPanel, pull: { ...PULL } };
      },
    );
    await sendUntilClaimed(view, "Don’t want to wait?");
    expect(view.actions.map((action) => action.type)).toEqual([
      "providers_wizard_opened",
      "onboarding_cloud_meanwhile_opened",
    ]);
    view.unmount();
  });

  it("download: a wheel notch is claimed and dropped — no list, no chat scroll", async () => {
    const view = mount(
      "local_download",
      { localModelId: "gemma-4-e4b" },
      (state) => {
        state.localModelsPanel = { ...state.localModelsPanel, pull: { ...PULL } };
      },
    );
    await sendUntilClaimed(view, "Downloading", {
      kind: "wheel",
      button: "none",
      wheel: "down",
    });
    expect(view.actions).toEqual([]);
    view.unmount();
  });

  it("cloud: the wizard's rows select on one click and activate on the second", async () => {
    const second = visibleKindRows(null)[1];
    if (!second) throw new Error("the kind list has fewer than two rows");
    const select = mount("cloud", {}, (state) => {
      state.providersPanel = {
        ...state.providersPanel,
        wizard: createProvidersWizardState("add"),
      };
    });
    await sendUntilClaimed(select, second.label);
    expect(select.actions).toHaveLength(1);
    const updated = select.actions[0];
    if (updated?.type !== "providers_wizard_updated") {
      throw new Error(`expected a wizard update, got ${updated?.type}`);
    }
    expect(updated.wizard.cursor).toBe(1);
    select.unmount();

    const first = visibleKindRows(null)[0];
    if (!first) throw new Error("the kind list is empty");
    const activate = mount("cloud", {}, (state) => {
      state.providersPanel = {
        ...state.providersPanel,
        wizard: createProvidersWizardState("add"),
      };
    });
    await sendUntilClaimed(activate, first.label);
    // Enter on the selected kind row advances the wizard — the same
    // routing the keyboard uses, so the phase moves off pick_kind.
    const advanced = activate.actions.find(
      (action) => action.type === "providers_wizard_updated",
    );
    if (!advanced || advanced.type !== "providers_wizard_updated") {
      throw new Error("the click did not reach the wizard's Enter");
    }
    expect(advanced.wizard.phase).not.toBe("pick_kind");
    activate.unmount();
  });

  it("hf_ref: [ clear ] empties the buffer and the error in one click", async () => {
    const view = mount("local_hf_ref", {
      hfReference: "owner/repo",
      error: "Hugging Face returned 404: no repo or revision by that name.",
    });
    await sendUntilClaimed(view, "[ clear ]");
    expect(view.actions).toEqual([
      { type: "onboarding_hf_reference_changed", value: "" },
      { type: "onboarding_error_set", error: null },
    ]);
    view.unmount();
  });

  it("hf_ref: ctrl+l clears through the same handler as the click", async () => {
    const view = mount("local_hf_ref", { hfReference: "owner/repo" });
    view.stdin.write("\f");
    await delay(60);
    expect(view.actions).toContainEqual({
      type: "onboarding_hf_reference_changed",
      value: "",
    });
    expect(view.actions).toContainEqual({ type: "onboarding_error_set", error: null });
    view.unmount();
  });
});
