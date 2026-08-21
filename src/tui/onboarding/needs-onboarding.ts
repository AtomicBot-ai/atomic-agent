import { getConfig } from "../../config/index.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
  isManagedModeReadyOnDisk,
} from "../run-local-models-config-wizard.js";

/** Why the first-run flow is (or is not) opening. Surfaced for tests and logs. */
export type OnboardingDecision =
  | { needed: false; reason: "completed" | "skipped" | "backend_configured" }
  | { needed: true; reason: "fresh_install" };

/**
 * Whether the first-run flow should open on this launch.
 *
 * Config decides, not a health probe. The old startup gate re-derived
 * the answer every launch from `checkLlamaServer()`, so an operator who
 * escaped out of setup — or whose llama-server merely happened to be
 * down — met the picker again on every single start. A backend that is
 * *configured* counts as onboarded even when it is not answering right
 * now; a backend that is down is the status bar's problem, not a reason
 * to re-run setup.
 */
export function decideOnboarding(): OnboardingDecision {
  const onboarding = getConfig().tui.onboarding;
  if (onboarding.completedAt) return { needed: false, reason: "completed" };
  if (onboarding.skippedAt) return { needed: false, reason: "skipped" };
  if (isCloudTextProviderReady() || isManagedModeReadyOnDisk() || isLocalBackendConfigured()) {
    return { needed: false, reason: "backend_configured" };
  }
  return { needed: true, reason: "fresh_install" };
}

export function needsOnboarding(): boolean {
  return decideOnboarding().needed;
}
