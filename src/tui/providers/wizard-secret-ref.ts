/**
 * A key typed on the /providers key screen as a reference (`op://…`,
 * `bw://…`, `vault://…`, `cmd://…`, ATO-2339) is read before the wizard
 * checks it or saves it (ATO-2530). Before, the reference itself was sent
 * to the service as the key, the check failed with a confusing "key
 * rejected", and nothing said that 1Password was simply locked.
 *
 * A reference that cannot be read stops the save with one plain sentence
 * naming the program and what to do, and the resolver's own reason on a
 * second "Details:" line. Neither line carries a value: the resolver's
 * messages name the variable and the program, never what it printed.
 */

import { getConfig } from "../../config/index.js";
import { secretRefSource, type SecretRefSource } from "../../config/saved-secret-refs.js";
import {
  resolveSecretRef,
  type SecretSpawner,
  type VaultFetcher,
} from "../../config/secret-ref-resolver.js";
import {
  looksLikeSecretRef,
  readSecretSources,
  type SecretSources,
} from "../../config/secret-refs.js";

export interface WizardSecretRefDeps {
  /** Defaults to `secret-sources.json` in the state directory. */
  sources?: SecretSources;
  spawn?: SecretSpawner;
  fetchVault?: VaultFetcher;
}

export type WizardKeyRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

const WHAT_TO_DO: Record<SecretRefSource, string> = {
  "1password":
    "Could not read this key from 1Password. Open 1Password and sign in (or check the op:// reference), then save again.",
  bitwarden:
    "Could not read this key from Bitwarden. Unlock Bitwarden (run `bw unlock` and set BW_SESSION) or check the bw:// reference, then save again.",
  vault:
    "Could not read this key from Vault. Check that VAULT_ADDR and VAULT_TOKEN are set and the vault:// path is right, then save again.",
  command:
    "The command for this key did not give a key. Check the cmd:// helper in secret-sources.json, then save again.",
};

/** The two-line message the wizard shows for an unreadable reference. */
export function describeUnreadableSecretRef(source: SecretRefSource, reason: string): string {
  const details = reason.trim();
  return details.length > 0 ? `${WHAT_TO_DO[source]}\nDetails: ${details}` : WHAT_TO_DO[source];
}

/**
 * Null when `typed` is not a reference (a plain key, or nothing typed).
 * Otherwise the value it names, or the message to show. `envVar` is the
 * variable the save writes the key under: a bare `cmd://` asks the helper
 * for that name, exactly as the next start will, and the Details line
 * names it.
 */
export async function readWizardKeyReference(
  typed: string,
  envVar: string,
  deps: WizardSecretRefDeps = {},
): Promise<WizardKeyRead | null> {
  const ref = typed.trim();
  if (!looksLikeSecretRef(ref)) return null;
  const source = secretRefSource(ref) ?? "command";
  try {
    const value = await resolveSecretRef(envVar, ref, {
      sources: deps.sources ?? readSecretSources(getConfig().paths.stateDir),
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      ...(deps.fetchVault === undefined ? {} : { fetchVault: deps.fetchVault }),
    });
    return { ok: true, value };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: describeUnreadableSecretRef(source, reason) };
  }
}
