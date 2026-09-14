import type { OnboardingState } from "../../config/index.js";
import { getConfig } from "../../config/index.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import type { TuiAction } from "../tui-action.js";
import { createOnboardingState } from "./onboarding-state.js";

/**
 * Every `tui.onboarding` stamp, cleared. A re-run is meant to be the
 * first run again, and each stamp would otherwise bend that walk:
 *
 * - `completedAt` / `skippedAt` are what retire the flow; left set, a
 *   re-run quit half-way would still count as onboarded next launch.
 * - `introSeenAt` is informational today, but a re-run does show the
 *   splash again, so the record should say so.
 * - `proposedSecondBackendAt`, `localSetupSeenAt` and `importOfferedAt`
 *   are the once-only offers. They exist so a *first* run never nags
 *   twice; on a run the operator asked for by name they would silently
 *   drop the "set up the other backend too" and "bring your data over"
 *   screens — often the very screens someone who skipped setup missed.
 *
 * Only these timestamps move. Providers, keys, the local model, sessions
 * and memory live elsewhere and are not touched: re-running setup walks
 * the screens again, it does not undo what they configured.
 */
export const ONBOARDING_RERUN_RESET: OnboardingState = {
  completedAt: null,
  introSeenAt: null,
  skippedAt: null,
  proposedSecondBackendAt: null,
  localSetupSeenAt: null,
  importOfferedAt: null,
};

/**
 * `/onboarding` (and the Setup menu row): clear the stamps, then mount
 * the flow from its splash. The stamps are written before the surface
 * opens so the lifecycle hook, which reads config on every step, sees a
 * fresh install from the first screen on.
 */
export function reopenOnboarding(dispatch: (action: TuiAction) => void): void {
  persistOnboardingState(ONBOARDING_RERUN_RESET);
  dispatch({
    type: "onboarding_set",
    onboarding: createOnboardingState(getConfig().localModels.url),
  });
}
