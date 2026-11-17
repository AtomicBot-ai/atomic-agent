import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setDotenvKey } from "./dotenv-writer.js";
import { parseDotenvText } from "./load-dotenv.js";
import {
  defaultSecretKeychain,
  isKeychainSecretName,
  readSecretsStoreState,
  type SecretKeychain,
  type SecretsStoreKind,
} from "./secret-store.js";

/**
 * One saved secret at a time, for clients outside this process (ATO-1639):
 * the desktop app saves and reads provider keys through
 * `atomic-agent config secrets set|get|unset` and `PUT /api/secrets/{name}`
 * instead of writing `<stateDir>/.env` itself, so a key lands wherever the
 * agent keeps keys (`.env`, the default, or the opt-in OS keychain from
 * ATO-474) and both apps read the same one.
 *
 * Only secret-shaped names (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`)
 * are accepted, so these surfaces can never be used to write `PATH`,
 * `NODE_OPTIONS` or any other variable the agent would load at start.
 */
export class SecretAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAccessError";
  }
}

/** Why `name` cannot go through these surfaces, or null. */
export function secretNameError(name: string): string | null {
  return isKeychainSecretName(name)
    ? null
    : `'${name}' is not an API key or token name (it must end in _KEY, _TOKEN, _SECRET or _PASSWORD)`;
}

/** Why `value` cannot be saved, or null. One line, no NUL, not empty. */
export function secretValueError(value: string): string | null {
  if (value.length === 0) return "the value is empty";
  if (/[\r\n\0]/.test(value)) return "the value must be one line";
  return null;
}

export interface SavedSecret {
  /** Where the value is now: the OS keychain, or `.env` (the default, or the keychain's fallback). */
  store: SecretsStoreKind;
}

/**
 * Save (or, with `null`, remove) one secret through the agent's own
 * writer, so the keychain choice and its `.env` fallback apply exactly as
 * they do for the terminal's provider wizard. Throws `SecretAccessError`
 * for a refused name or value; never logs the value.
 */
export function saveSecret(
  stateDir: string,
  name: string,
  value: string | null,
  keychain?: SecretKeychain,
): SavedSecret {
  const nameError = secretNameError(name);
  if (nameError) throw new SecretAccessError(nameError);
  if (value !== null) {
    const valueError = secretValueError(value);
    if (valueError) throw new SecretAccessError(valueError);
  }
  setDotenvKey(stateDir, name, value, keychain);
  const held = readSecretsStoreState(stateDir).keychainKeys.includes(name);
  return { store: value !== null && held ? "keychain" : "env" };
}

export type SavedSecretRead =
  | { ok: true; value: string | null; store: SecretsStoreKind }
  | { ok: false };

/**
 * The saved value of one secret, by the loader's precedence: a `.env`
 * line wins (it is the newer value after a keychain fallback), then the
 * keychain entry when the name is listed there. The process environment
 * is not consulted: this answers what is saved, not what a shell set.
 * `{ ok: false }` when the keychain held it but could not be read.
 */
export function readSavedSecret(
  stateDir: string,
  name: string,
  keychain: SecretKeychain = defaultSecretKeychain(),
): SavedSecretRead {
  const nameError = secretNameError(name);
  if (nameError) throw new SecretAccessError(nameError);
  const envPath = join(stateDir, ".env");
  if (existsSync(envPath)) {
    const fromFile = parseDotenvText(readFileSync(envPath, "utf8")).get(name);
    if (fromFile !== undefined && fromFile.length > 0) {
      return { ok: true, value: fromFile, store: "env" };
    }
  }
  const state = readSecretsStoreState(stateDir);
  if (state.store !== "keychain" || !state.keychainKeys.includes(name)) {
    return { ok: true, value: null, store: "env" };
  }
  const read = keychain.read(name);
  if (!read.ok) return { ok: false };
  return { ok: true, value: read.value, store: "keychain" };
}
