import type { OnboardingOutcome } from "./onboarding-state.js";

export interface SecondBackendInputs {
  /** How the operator finished the first backend. */
  outcome: OnboardingOutcome;
  /** A cloud text provider is configured and usable. */
  cloudReady: boolean;
  /** A local backend was chosen (managed model picked, or an external URL). */
  localReady: boolean;
  /** `tui.onboarding.proposedSecondBackendAt` — the offer was already made. */
  alreadyProposed: boolean;
}

/** Which backend the flow should offer next, or `null` to hand over. */
export type SecondBackendOffer = "local" | "cloud" | null;

/**
 * Whether to offer the other backend, and which one.
 *
 * atomic-agent runs local and cloud side by side, and an operator who
 * has just configured one rarely knows the other is a switch away. The
 * offer is made once, and only when it would add something:
 *
 * - **Custom endpoint never sees it.** Someone pointing the agent at a
 *   server they already run has answered this question by running it.
 * - **Both configured, no offer.** There is nothing left to add.
 * - **Skipped, no offer.** They asked to be left alone.
 * - **Once only**, recorded in config, so a second first-run — after a
 *   reset, or on a machine where setup was interrupted — does not nag.
 */
export function decideSecondBackendOffer(inputs: SecondBackendInputs): SecondBackendOffer {
  if (inputs.alreadyProposed) return null;
  if (inputs.outcome === "custom" || inputs.outcome === "skipped") return null;
  if (inputs.cloudReady && inputs.localReady) return null;
  if (inputs.outcome === "local") return inputs.cloudReady ? null : "cloud";
  return inputs.localReady ? null : "local";
}
