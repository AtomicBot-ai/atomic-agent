import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotenvText } from "./load-dotenv.js";
import { looksLikeSecretRef } from "./secret-refs.js";
import { defaultSecretKeychain, readSecretsStoreState, type SecretKeychain } from "./secret-store.js";

/**
 * Where a saved key really comes from (ATO-2530), for the desktop's
 * "from 1Password" label and `atag doctor`: the scheme of a reference
 * (ATO-2339), never its value. A key saved as plain text is not listed;
 * the caller already knows whether it sits in `.env` or the keychain.
 */
export type SecretRefSource = "1password" | "bitwarden" | "vault" | "command";

/** The source a saved value names, or null for a plain value. */
export function secretRefSource(value: string): SecretRefSource | null {
  const raw = value.trim();
  if (!looksLikeSecretRef(raw)) return null;
  if (raw.startsWith("op://")) return "1password";
  if (raw.startsWith("bw://")) return "bitwarden";
  if (raw.startsWith("vault://")) return "vault";
  return "command";
}

export interface SavedSecretRefEntry {
  name: string;
  /** The reference as saved (`op://vault/item/field`): a location, not a value. */
  ref: string;
  source: SecretRefSource;
  /** Where the reference itself is saved. */
  store: "env" | "keychain";
}

/**
 * Saved keys written as references: `.env` first (it wins at load, as in
 * `readSavedSecret`), then the keychain names `.env` does not hold. Reads
 * nothing it does not need: plain values are skipped, the keychain only
 * when it is the store. A keychain entry that cannot be read is skipped.
 */
export function listSavedSecretRefs(
  stateDir: string,
  keychain: SecretKeychain = defaultSecretKeychain(),
): SavedSecretRefEntry[] {
  const out: SavedSecretRefEntry[] = [];
  const seen = new Set<string>();
  const envPath = join(stateDir, ".env");
  if (existsSync(envPath)) {
    for (const [name, value] of parseDotenvText(readFileSync(envPath, "utf8"))) {
      if (value.length === 0) continue;
      seen.add(name);
      const source = secretRefSource(value);
      if (source !== null) out.push({ name, ref: value.trim(), source, store: "env" });
    }
  }
  const state = readSecretsStoreState(stateDir);
  if (state.store !== "keychain") return out;
  for (const name of state.keychainKeys) {
    if (seen.has(name)) continue;
    const read = keychain.read(name);
    if (!read.ok || read.value === null) continue;
    const source = secretRefSource(read.value);
    if (source !== null) out.push({ name, ref: read.value.trim(), source, store: "keychain" });
  }
  return out;
}
