import { useInput } from "ink";
import { useCallback, useState } from "react";
import type { OnboardingScreenCallbacks } from "../components/onboarding-screen.js";
import type { LocalModelPick } from "../onboarding/local-model-picks.js";
import { handleOnboardingKey } from "../onboarding/onboarding-key-bindings.js";
import type {
  OnboardingOutcome,
  OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { routeProvidersWizardKey } from "../providers/route-wizard-key.js";
import {
  createProvidersWizardState,
  type ProvidersWizardState,
} from "../providers/providers-wizard-state.js";
import type { TuiAction } from "../tui-action.js";
import type { LocalModelId } from "../../local-llm/index.js";

/**
 * Every key the first-run flow answers to, one `useInput` per step so a
 * screen's handler is active exactly while that screen is up. Extracted
 * from `OnboardingScreen` whole: the screen keeps layout and effects,
 * this hook keeps the keys, and neither has to scroll past the other.
 */
export function useOnboardingInputs(args: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  callbacks: OnboardingScreenCallbacks;
  picks: readonly LocalModelPick[];
  wizardState: ProvidersWizardState | null;
  finish(outcome: OnboardingOutcome): void;
}): { introSkipped: boolean } {
  const { onboarding, dispatch, callbacks, picks, wizardState, finish } = args;
  const [introSkipped, setIntroSkipped] = useState(false);

  const pick = useCallback(
    (choice: "local" | "cloud" | "custom") => {
      if (choice === "cloud") {
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_step_set", step: "cloud" });
        return;
      }
      if (choice === "custom") {
        dispatch({ type: "onboarding_step_set", step: "custom_chat_url" });
        return;
      }
      // Managed mode is recorded now so a Ctrl+C mid-download does not
      // lose the choice; the model id follows when the pull completes.
      persistUserLocalModelsConfig({ mode: "managed" });
      dispatch({ type: "onboarding_step_set", step: "local_pick" });
    },
    [dispatch],
  );

  useInput(
    (input, key) => {
      const result = handleOnboardingKey(input, key, onboarding);
      if (!result.handled) return;
      for (const action of result.actions) dispatch(action);
      const intent = result.intent;
      if (!intent) return;
      if (intent.kind === "intro_key") {
        // First key finishes the reveal, second moves on: a splash that
        // cannot be hurried is a wait, and one that vanishes on the key
        // that was meant to hurry it is a screen nobody ever reads.
        if (!introSkipped) {
          setIntroSkipped(true);
          return;
        }
        // Recorded as it is dismissed, not at the end of the flow: an
        // operator who quits at the backend choice has still seen the
        // splash, and a later release may want to know that.
        persistOnboardingState({ introSeenAt: new Date().toISOString() });
        dispatch({ type: "onboarding_step_set", step: "choose" });
        return;
      }
      if (intent.kind === "skip") finish("skipped");
      else pick(intent.choice);
    },
    { isActive: onboarding.step === "choose" || onboarding.step === "intro" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        dispatch({ type: "onboarding_step_set", step: "choose" });
        return;
      }
      if (key.upArrow || input === "k") {
        dispatch({ type: "onboarding_cursor_moved", delta: -1, length: picks.length });
        return;
      }
      if (key.downArrow || input === "j") {
        dispatch({ type: "onboarding_cursor_moved", delta: 1, length: picks.length });
        return;
      }
      if (key.return) {
        const chosen = picks[onboarding.cursor % Math.max(1, picks.length)];
        if (!chosen) return;
        dispatch({ type: "onboarding_local_model_picked", modelId: chosen.id });
        callbacks.onLocalModelsPullRequested?.(chosen.id as LocalModelId);
      }
    },
    { isActive: onboarding.step === "local_pick" },
  );

  useInput(
    (input, key) => {
      if (input === "c" && !key.ctrl) {
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_cloud_meanwhile_opened" });
      }
    },
    { isActive: onboarding.step === "local_download" },
  );

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        dispatch({
          type: "onboarding_cursor_moved",
          delta: key.upArrow || input === "k" ? -1 : 1,
          length: 2,
        });
        return;
      }
      if (key.return) {
        if (onboarding.cursor % 2 === 0) finish(onboarding.outcome ?? "cloud");
        else dispatch({ type: "onboarding_step_set", step: "local_download" });
      }
    },
    { isActive: onboarding.step === "wait_or_jump" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        finish(onboarding.outcome ?? "skipped");
        return;
      }
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        dispatch({
          type: "onboarding_cursor_moved",
          delta: key.upArrow || input === "k" ? -1 : 1,
          length: 2,
        });
        return;
      }
      if (key.return) {
        if (onboarding.cursor !== 0) {
          finish(onboarding.outcome ?? "skipped");
          return;
        }
        if (onboarding.offer === "local") {
          persistUserLocalModelsConfig({ mode: "managed" });
          dispatch({ type: "onboarding_step_set", step: "local_pick" });
          return;
        }
        dispatch({
          type: "providers_wizard_opened",
          wizard: createProvidersWizardState("add"),
        });
        dispatch({ type: "onboarding_step_set", step: "cloud" });
      }
    },
    { isActive: onboarding.step === "propose_second" },
  );

  // The cloud step *is* the providers wizard — same keys, same
  // verification, same hot-swap — so it routes through the panel's own
  // handler rather than a second implementation of it.
  useInput(
    (input, key) => {
      if (!wizardState) return;
      routeProvidersWizardKey(input, key, wizardState, {
        dispatch,
        onSubmit: (wizard) => callbacks.onProvidersWizardSubmit?.(wizard),
        onSubmitCancel: () => callbacks.onProvidersWizardSubmitCancel?.(),
      });
    },
    { isActive: onboarding.step === "cloud" && wizardState !== null },
  );

  return { introSkipped };
}
