/**
 * One {@link PrivacyVault} per session (ATO-599), so placeholders stay
 * stable across the turns of a chat and never mean another chat's data.
 * In memory only, like the vaults themselves. The counters read here
 * feed the "masked N" line of the Privacy tab and Settings › Privacy.
 */

import { knownSecretsFromEnv, type KnownSecret } from "../error-reporting/secret-detector.js";
import { PrivacyVault } from "./privacy-vault.js";

/** Requests without a session id (one-off sub-calls) share this vault. */
export const SHARED_VAULT_KEY = "*";

const vaults = new Map<string, PrivacyVault>();
/** The agent's own keys (its `.env` is loaded into `process.env`). */
let knownSecrets: () => readonly KnownSecret[] = () => knownSecretsFromEnv();
let shieldEnabled = false;

/**
 * Whether Privacy Shield is on for this process. Read per request by
 * the cloud provider adapters, so a toggle applies to the next request
 * without rebuilding a provider; set from `privacy.shield.enabled` at
 * startup and by the live toggle. Same shape as `isOfflineNetwork`.
 */
export function isPrivacyShieldEnabled(): boolean {
  return shieldEnabled;
}

export function setPrivacyShieldEnabled(enabled: boolean): void {
  shieldEnabled = enabled;
}

/** Exact values every new vault treats as secret (the agent's own keys). */
export function setPrivacyKnownSecrets(source: () => readonly KnownSecret[]): void {
  knownSecrets = source;
}

export function privacyVaultFor(sessionId: string | null | undefined): PrivacyVault {
  const key = sessionId && sessionId.length > 0 ? sessionId : SHARED_VAULT_KEY;
  let vault = vaults.get(key);
  if (!vault) {
    vault = new PrivacyVault(() => knownSecrets());
    vaults.set(key, vault);
  }
  return vault;
}

/** Drop a session's vault (the session was deleted). */
export function forgetPrivacyVault(sessionId: string): void {
  vaults.delete(sessionId);
}

export interface PrivacyShieldTotals {
  /** Distinct values masked, summed over every session of this process. */
  masked: number;
  /** Sessions that had anything masked. */
  sessions: number;
}

export function privacyShieldTotals(): PrivacyShieldTotals {
  let masked = 0;
  let sessions = 0;
  for (const vault of vaults.values()) {
    const { distinct } = vault.stats();
    masked += distinct;
    if (distinct > 0) sessions += 1;
  }
  return { masked, sessions };
}

/** Tests only. */
export function resetPrivacyVaults(): void {
  vaults.clear();
  knownSecrets = () => knownSecretsFromEnv();
  shieldEnabled = false;
}
