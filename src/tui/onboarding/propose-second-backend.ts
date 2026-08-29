import type { OnboardingOutcome, OnboardingStep } from "./onboarding-state.js";

export interface SecondBackendInputs {
  /** How the operator finished the first backend. */
  outcome: OnboardingOutcome;
  /** A cloud text provider is configured and usable. */
  cloudReady: boolean;
  /** A local backend was chosen (managed model picked, or an external URL). */
  localReady: boolean;
  /** `tui.onboarding.proposedSecondBackendAt` — the offer was already made. */
  alreadyProposed: boolean;
  /**
   * `tui.onboarding.localSetupSeenAt` — the local branch was reached at
   * some point, whether or not a model came out of it.
   */
  localSetupSeen: boolean;
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
 * - **The local pitch is for people who never looked.** Walking into
 *   the model list and walking back out is an answer: they saw the
 *   sizes, the download times, and chose not to. Pitching the same
 *   screen a step later reads as not having listened. `localReady`
 *   alone cannot see that visit, because backing out configures
 *   nothing. The mirrored direction is not symmetric — the cloud pitch
 *   costs a key and an API key the operator either has or does not, so
 *   it keeps the rules above and nothing more.
 */
export function decideSecondBackendOffer(inputs: SecondBackendInputs): SecondBackendOffer {
  if (inputs.alreadyProposed) return null;
  if (inputs.outcome === "custom" || inputs.outcome === "skipped") return null;
  if (inputs.cloudReady && inputs.localReady) return null;
  if (inputs.outcome === "local") return inputs.cloudReady ? null : "cloud";
  if (inputs.localSetupSeen) return null;
  return inputs.localReady ? null : "local";
}

/**
 * Steps that count as having seen the local branch.
 *
 * `local_pick` is the list itself; the two download steps are only
 * reachable through it, and are listed anyway so a future shortcut
 * straight into a pull cannot quietly reopen the pitch.
 */
export function isLocalSetupStep(step: OnboardingStep): boolean {
  return step === "local_pick" || step === "local_download" || step === "wait_or_jump";
}
