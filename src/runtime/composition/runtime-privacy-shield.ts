import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import {
  isPrivacyShieldEnabled,
  privacyShieldTotals,
  privacyVaultFor,
  setPrivacyShieldEnabled,
} from "../../privacy/index.js";
import type { PrivacyNamesStatus, PrivacyShieldControl, PrivacyShieldStats } from "../runtime-contract.js";
import { persistPrivacyLocalNames, privacyNamesStatus } from "./runtime-privacy-names-status.js";

export interface PrivacyShieldDeps {
  /** Write `privacy.shield.enabled` to the user config file. */
  persist?: (enabled: boolean) => void;
  /** Write `privacy.shield.localNames` to the user config file (ATO-2527). */
  persistNames?: (enabled: boolean) => void;
  /** The names status as config says now (ATO-2527). */
  namesStatus?: () => PrivacyNamesStatus;
}

/**
 * `runtime.privacyShield` (ATO-1082): the live switch the TUI Privacy
 * tab, `/api/privacy-shield` and the desktop's Settings › Privacy row
 * drive. `setEnabled` persists the key, then flips the process switch the
 * cloud providers read per request, so the next request is masked (or
 * not) without rebuilding anything. Same shape as `runtime.offlineMode`.
 */
export function createPrivacyShieldControl(deps: PrivacyShieldDeps = {}): PrivacyShieldControl {
  const persist = deps.persist ?? persistPrivacyShield;
  const persistNames = deps.persistNames ?? persistPrivacyLocalNames;
  const namesStatus = deps.namesStatus ?? (() => privacyNamesStatus());
  return {
    isEnabled: () => isPrivacyShieldEnabled(),
    async setEnabled(enabled: boolean): Promise<void> {
      persist(enabled);
      setPrivacyShieldEnabled(enabled);
    },
    stats(sessionId?: string): PrivacyShieldStats {
      const totals = privacyShieldTotals();
      if (!sessionId) return totals;
      const vault = privacyVaultFor(sessionId).stats();
      return { ...totals, session: { masked: vault.distinct, lastRequest: vault.lastRequest } };
    },
    // The name pass reads the key from config per request, so persisting
    // it is all a toggle needs (runtime-privacy-names.ts).
    localNames: {
      status: namesStatus,
      async setEnabled(enabled: boolean): Promise<void> {
        persistNames(enabled);
      },
    },
  };
}

/** read → merge → validate → write → reset, like the other persist helpers. */
export function persistPrivacyShield(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    privacy: { ...prev.privacy, shield: { ...prev.privacy?.shield, enabled } },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
