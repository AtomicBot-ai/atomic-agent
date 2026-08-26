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
  onStep?(step: string, outcome?: string): void;
}): void {
  const { onboarding, dispatch, onFinished, onStep } = input;
  const settling = useRef(false);
  // Steps already reported, so a re-render — or a second visit to the
  // same screen — does not double-count it. `finished` in particular is
  // entered twice whenever the second-backend offer intercepts it: the
  // effect below dispatches the offer and returns early, then the flow
  // comes back to `finished` to settle for real.
  const reportedSteps = useRef(new Set<string>());

  // One event per screen the operator actually reaches. This is the
  // whole point of the funnel: `app_installed` and `first_message_sent`
  // alone say that people leave, never at which screen.
  useEffect(() => {
    if (!onStep) return;
    // `outcome` is set together with the `finished` step, so it is part
    // of the identity of that report rather than a later addition —
    // keying on the pair keeps a null-outcome render from claiming the
    // slot and suppressing the real one.
    const key =
      onboarding.outcome === null
        ? onboarding.step
        : `${onboarding.step}:${onboarding.outcome}`;
    if (reportedSteps.current.has(key)) return;
    reportedSteps.current.add(key);
    onStep(
      onboarding.step,
      ...(onboarding.outcome !== null
        ? ([onboarding.outcome] as const)
        : ([] as const)),
    );
  }, [onStep, onboarding.step, onboarding.outcome]);

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
