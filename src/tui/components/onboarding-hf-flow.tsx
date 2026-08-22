import type { ReactElement } from "react";

import { useOnboardingHuggingFace } from "../hooks/use-onboarding-huggingface.js";
import type { OnboardingUiState } from "../onboarding/onboarding-state.js";
import type { TuiAction } from "../tui-action.js";
import { OnboardingHuggingFacePickStep } from "./onboarding-hf-pick-step.js";
import { OnboardingHuggingFaceRefStep } from "./onboarding-hf-ref-step.js";

/**
 * The whole "add a model from Hugging Face" branch — the reference
 * editor, the file list, and the hook that owns the lookup effect. The
 * file list's keys (and the download its Enter starts) live in the
 * flow-wide key table, `onboarding-hf-keys.ts`, where the mouse can
 * reach them too.
 *
 * Its own module rather than two more branches in `OnboardingScreen`:
 * that file predates the 300-line budget and every slice touching it
 * collides with every other, so the branch keeps its render and its
 * lookup wiring in one place the screen only mounts.
 *
 * Mounted on every step and rendering `null` off its own two — the hook
 * inside subscribes to `useInput`, and hooks cannot sit behind an early
 * return in the parent.
 */
export function OnboardingHuggingFaceFlow(props: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  ramGb: number;
}): ReactElement | null {
  const { onboarding, dispatch } = props;
  const huggingFace = useOnboardingHuggingFace({ onboarding, dispatch });
  if (onboarding.step === "local_hf_ref") {
    return (
      <OnboardingHuggingFaceRefStep
        value={onboarding.hfReference}
        busy={onboarding.busy}
        error={onboarding.error}
        onChange={(value) =>
          dispatch({ type: "onboarding_hf_reference_changed", value })
        }
        onSubmit={huggingFace.resolveReference}
        onClear={huggingFace.clearReference}
        onBack={() => dispatch({ type: "onboarding_step_set", step: "local_pick" })}
      />
    );
  }
  if (onboarding.step === "local_hf_pick" && onboarding.hfRepo) {
    return (
      <OnboardingHuggingFacePickStep
        repo={onboarding.hfRepo}
        cursor={onboarding.cursor % Math.max(1, onboarding.hfRepo.choices.length)}
        ramGb={props.ramGb}
        error={onboarding.error}
      />
    );
  }
  return null;
}
