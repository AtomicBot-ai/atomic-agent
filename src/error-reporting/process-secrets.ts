/**
 * Secrets this process holds in memory only, offered to the secret
 * masker (ATO-1705).
 *
 * Most of the agent's own secrets are found by name: `.env` is loaded
 * into `process.env` (`knownSecretsFromEnv`) and the config file holds
 * the rest (`runtimeKnownSecrets`). The key `atomic-agent serve` runs
 * with is neither when it came from `--api-key` or from the generated
 * `<stateDir>/serve-api.key`: a tool that printed it (`ps` showing a
 * launcher's command line, a log the agent reads back) would hand it to
 * the model, the transcript and the trace. Serve registers it here once
 * it is resolved, and every masking site adds {@link processSecrets} to
 * its exact values, the way `commandIssuedSecrets` does for a provider
 * key command's token.
 *
 * Only registration, never a way back to the value for anyone but the
 * masker: the list is not exported as mutable state.
 */

import type { KnownSecret } from "./secret-detector.js";

const registered = new Map<string, string>();

/** Remember `value` as secret under `label` (one value per label; a new one replaces it). */
export function registerProcessSecret(label: string, value: string): void {
  if (value.length === 0) return;
  registered.set(label, value);
}

/** The secrets registered in this process, for `maskSecrets`. */
export function processSecrets(): KnownSecret[] {
  return [...registered].map(([label, value]) => ({ label, value }));
}

/** Tests only: forget every registered secret. */
export function clearProcessSecretsForTests(): void {
  registered.clear();
}
