import { describe, expect, it } from "vitest";

import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import { returnKey } from "../mouse/synthetic-key.js";
import { visibleKindRows } from "../providers/providers-wizard-phases.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { measureOnboardingChooseStep } from "./onboarding-choose-step.js";
import { computeOnboardingFit } from "./onboarding-fit.js";
import {
  chooseCursorFor,
  customBranchFor,
  customDetailLine,
} from "./onboarding-local-servers.js";
import { reduceOnboardingAction } from "./onboarding-reducer.js";
import {
  createOnboardingState,
  ONBOARDING_CHOICES,
  type OnboardingStep,
  type OnboardingUiState,
} from "./onboarding-state.js";
import { handleOnboardingStepKey } from "./onboarding-step-keys.js";

const OLLAMA: DetectedLocalServer = {
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  presetId: "ollama",
  models: ["qwen3:8b"],
  loaded: [],
};
const LLAMA_APP: DetectedLocalServer = {
  kind: "llama-app",
  label: "Llama app (llama.cpp)",
  baseUrl: "http://127.0.0.1:9931",
  presetId: null,
  models: ["gemma-3-4b-it"],
  loaded: [],
};

const CUSTOM_INDEX = ONBOARDING_CHOICES.findIndex((c) => c.id === "custom");

function stateAt(step: OnboardingStep, over: Partial<OnboardingUiState> = {}): TuiState {
  const onboarding = { ...createOnboardingState("http://127.0.0.1:8080"), step, ...over };
  return { ...createInitialTuiState(fakeSession(), 50), onboarding };
}

function pressEnter(state: TuiState): TuiAction[] {
  const actions: TuiAction[] = [];
  handleOnboardingStepKey("", returnKey(), {
    state,
    dispatch: (action) => actions.push(action),
    callbacks: {},
  });
  return actions;
}

describe("choice screen helpers", () => {
  it("starts on Custom only when something runs here", () => {
    expect(CUSTOM_INDEX).toBeGreaterThan(0);
    expect(chooseCursorFor({})).toBe(0);
    expect(chooseCursorFor({ detectedLocal: [] })).toBe(0);
    expect(chooseCursorFor({ detectedLocal: [OLLAMA] })).toBe(CUSTOM_INDEX);
  });

  it("names the found servers on the Custom row", () => {
    expect(customDetailLine(undefined, "usual")).toBe("usual");
    expect(customDetailLine([LLAMA_APP, OLLAMA], "usual")).toBe(
      "Found running here: Llama app, Ollama.",
    );
  });

  it("measures the found line in place of the usual Custom detail", () => {
    const fit = computeOnboardingFit({ columns: 200, rows: 60 });
    // A server label long enough to be the widest line on the screen.
    const wide = { ...OLLAMA, kind: "lmstudio" as const };
    const many = [LLAMA_APP, OLLAMA, wide];
    const found = customDetailLine(many, "");
    expect(found).toBe("Found running here: Llama app, Ollama, LM Studio.");
    // The measure must change with the line it draws, or the block is
    // centred on a width it does not have.
    if (fit.rowDetails) {
      expect(measureOnboardingChooseStep(fit, many)).toBeGreaterThanOrEqual(found.length);
    }
  });

  it("sends llama.cpp to the URL step and Ollama to the provider list", () => {
    expect(customBranchFor({})).toBeNull();
    expect(customBranchFor({ detectedLocal: [OLLAMA, LLAMA_APP] })).toEqual({
      kind: "llama_url",
      url: "http://127.0.0.1:9931",
    });
    expect(customBranchFor({ detectedLocal: [OLLAMA] })).toEqual({
      kind: "provider_list",
      detected: [OLLAMA],
    });
  });
});

describe("onboarding_local_servers_detected", () => {
  it("moves an untouched choice screen to Custom", () => {
    const next = reduceOnboardingAction(stateAt("choose"), {
      type: "onboarding_local_servers_detected",
      servers: [OLLAMA],
    });
    expect(next?.onboarding?.detectedLocal).toEqual([OLLAMA]);
    expect(next?.onboarding?.cursor).toBe(CUSTOM_INDEX);
  });

  it("leaves a cursor the operator moved", () => {
    const next = reduceOnboardingAction(stateAt("choose", { cursor: 1 }), {
      type: "onboarding_local_servers_detected",
      servers: [OLLAMA],
    });
    expect(next?.onboarding?.cursor).toBe(1);
  });

  it("found on the splash, the choice screen opens on Custom", () => {
    const found = reduceOnboardingAction(stateAt("intro"), {
      type: "onboarding_local_servers_detected",
      servers: [LLAMA_APP],
    })!;
    const choose = reduceOnboardingAction(found, { type: "onboarding_step_set", step: "choose" });
    expect(choose?.onboarding?.cursor).toBe(CUSTOM_INDEX);
  });

  it("without a find the choice screen still opens on the first row", () => {
    const choose = reduceOnboardingAction(stateAt("intro"), {
      type: "onboarding_step_set",
      step: "choose",
    });
    expect(choose?.onboarding?.cursor).toBe(0);
  });
});

describe("Enter on Custom with a server running here", () => {
  it("opens the provider list with Ollama on top", () => {
    const actions = pressEnter(
      stateAt("choose", { cursor: CUSTOM_INDEX, detectedLocal: [OLLAMA] }),
    );
    const opened = actions.find((a) => a.type === "providers_wizard_opened");
    if (!opened || opened.type !== "providers_wizard_opened") throw new Error("no wizard");
    expect(opened.wizard.detectedLocal).toEqual([OLLAMA]);
    const top = visibleKindRows(null, opened.wizard.detectedLocal)[0]!.row;
    expect(typeof top === "object" && top.presetId).toBe("ollama");
    expect(actions).toContainEqual({ type: "onboarding_step_set", step: "cloud" });
  });

  it("fills the URL step with the Llama app's address", () => {
    const actions = pressEnter(
      stateAt("choose", { cursor: CUSTOM_INDEX, detectedLocal: [LLAMA_APP] }),
    );
    expect(actions).toContainEqual({
      type: "onboarding_url_changed",
      field: "chat",
      value: "http://127.0.0.1:9931",
    });
    expect(actions).toContainEqual({ type: "onboarding_step_set", step: "custom_chat_url" });
  });

  it("with nothing found, opens the empty URL step as before", () => {
    const actions = pressEnter(stateAt("choose", { cursor: CUSTOM_INDEX }));
    expect(actions.some((a) => a.type === "onboarding_url_changed")).toBe(false);
    expect(actions.some((a) => a.type === "providers_wizard_opened")).toBe(false);
    expect(actions).toContainEqual({ type: "onboarding_step_set", step: "custom_chat_url" });
  });
});
