import type { OnboardingState } from "../config/index.js";
import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Record a step of the first-run flow into `tui.onboarding`, then
 * invalidate the config cache so the next `getConfig()` sees it. Mirrors
 * the other `persist-*` helpers: read → merge → validate → write → reset.
 *
 * The patch carries timestamps rather than booleans, and the caller
 * stamps them (`new Date().toISOString()`), so tests can write a fixed
 * instant instead of freezing the clock.
 */
export function persistOnboardingState(patch: Partial<OnboardingState>): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    tui: { ...prev.tui, onboarding: { ...prev.tui.onboarding, ...patch } },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
