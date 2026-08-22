import { useEffect, useRef } from "react";
import { getConfig } from "../../config/index.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
} from "../local-backend-readiness.js";
import type {
  OnboardingOutcome,
  OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import {
  decideSecondBackendOffer,
  isLocalSetupStep,
} from "../onboarding/propose-second-backend.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The flow's persistence effects, out of the screen so the screen stays
 * its shell — placement and the footer — the same split that already
 * holds for the keys (`useOnboardingInputs`) and the endpoint writes
 * (`useOnboardingUrlActions`).
 */
export function useOnboardingLifecycle(input: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  onFinished?(outcome: OnboardingOutcome): void;
}): void {
  const { onboarding, dispatch, onFinished } = input;
  const settling = useRef(false);

  // Stamped on arrival rather than on success, and before anything is
  // downloaded: an operator who opened the model list and pressed esc
  // has already read everything the later "set up local models too"
  // screen would tell them.
  useEffect(() => {
    if (!isLocalSetupStep(onboarding.step)) return;
    if (getConfig().tui.onboarding.localSetupSeenAt !== null) return;
    persistOnboardingState({ localSetupSeenAt: new Date().toISOString() });
  }, [onboarding.step]);

  // Closing down runs once. The stamp is what stops the flow reopening
  // on the next launch, so it is written before the surface unmounts.
  useEffect(() => {
    if (onboarding.step !== "finished" || settling.current) return;
    const outcome = onboarding.outcome ?? "skipped";
    const config = getConfig();
    // The download screen's skip exit goes straight to the agent: that
    // screen pitched cloud ("press c") right above the skip row, so
    // replaying the pitch here would be nagging. The bypass is this
    // explicit flag and NOT a `proposedSecondBackendAt` stamp — the
    // stamp means "the propose screen was shown once", which it was
    // not; and since `completedAt` below retires the flow anyway, the
    // stamp could only ever act on a re-run after a reset, where
    // suppressing a screen the operator never saw would be wrong.
    const offer = onboarding.skipSecondOffer
      ? null
      : decideSecondBackendOffer({
          outcome,
          cloudReady: isCloudTextProviderReady(),
          localReady: isLocalBackendConfigured(),
          alreadyProposed: config.tui.onboarding.proposedSecondBackendAt !== null,
          localSetupSeen: config.tui.onboarding.localSetupSeenAt !== null,
        });
    if (offer) {
      // Recorded when it is shown, not when it is answered: the offer
      // was made either way, and a declined offer must not come back.
      persistOnboardingState({ proposedSecondBackendAt: new Date().toISOString() });
      dispatch({ type: "onboarding_second_backend_offered", offer });
      return;
    }
    settling.current = true;
    const now = new Date().toISOString();
    persistOnboardingState(outcome === "skipped" ? { skippedAt: now } : { completedAt: now });
    onFinished?.(outcome);
    dispatch({ type: "onboarding_set", onboarding: null });
  }, [
    dispatch,
    onFinished,
    onboarding.outcome,
    onboarding.skipSecondOffer,
    onboarding.step,
  ]);
}
