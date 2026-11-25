import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setDotenvFileKey } from "./dotenv-writer.js";
import { parseDotenvText } from "./load-dotenv.js";
import {
  defaultSecretKeychain,
  isKeychainSecretName,
  readSecretsStoreState,
  writeSecretsStoreState,
  type SecretKeychain,
  type SecretsStoreKind,
} from "./secret-store.js";

/**
 * Move saved secrets between `.env` and the OS keychain (ATO-474), for
 * `atomic-agent config secrets keychain|env`. Names only ever leave
 * this module; values go straight from one store to the other.
 *
 * Each key is copied before it is removed from its old place, and
 * `secrets-store.json` is updated before the `.env` line goes, so an
 * interrupted move leaves every key loadable from at least one store.
 */
export interface SecretsMigrationResult {
  /** The store in effect afterwards. */
  store: SecretsStoreKind;
  /** Names that now live in the target store. */
  moved: string[];
  /** Names that stayed in the old store because the keychain failed. */
  left: string[];
  /** Copied to `.env`, but the keychain entry could not be deleted. */
  orphaned: string[];
  /** False when the keychain could not be used at all, or some keys were left. */
  ok: boolean;
}

/** Throwaway account used to prove the keychain works when there is nothing to move yet. */
const PROBE_ACCOUNT = "ATOMIC_AGENT_KEYCHAIN_PROBE";

function readEnvEntries(stateDir: string): Map<string, string> {
  const path = join(stateDir, ".env");
  if (!existsSync(path)) return new Map();
  return parseDotenvText(readFileSync(path, "utf8"));
}

/**
 * Switch to the keychain: every API key / token line of `.env` moves
 * to the keychain. Nothing is switched when the keychain does not work
 * on this machine, so a failed attempt leaves the default untouched.
 */
export function moveSecretsToKeychain(
  stateDir: string,
  keychain: SecretKeychain = defaultSecretKeychain(),
): SecretsMigrationResult {
  const state = readSecretsStoreState(stateDir);
  const candidates = [...readEnvEntries(stateDir)].filter(([key]) =>
    isKeychainSecretName(key),
  );
  const keys = new Set(state.keychainKeys);
  const moved: string[] = [];
  const left: string[] = [];
  let works = false;

  if (candidates.length === 0) {
    works = keychain.write(PROBE_ACCOUNT, "ok") && keychain.remove(PROBE_ACCOUNT);
  }
  for (const [key, value] of candidates) {
    if (!keychain.write(key, value)) {
      left.push(key);
      continue;
    }
    works = true;
    keys.add(key);
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [...keys] });
    setDotenvFileKey(stateDir, key, null);
    moved.push(key);
  }
  if (works && candidates.length === 0) {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [...keys] });
  }
  return {
    store: works ? "keychain" : state.store,
    moved,
    left,
    orphaned: [],
    ok: works && left.length === 0,
  };
}

/**
 * Switch back to `.env`: every key listed as held in the keychain is
 * written to `.env` (a `.env` line already there is newer and wins) and
 * then deleted from the keychain. Keys that cannot be read stay listed,
 * and the store stays `keychain` until they are moved too.
 */
export function moveSecretsToEnv(
  stateDir: string,
  keychain: SecretKeychain = defaultSecretKeychain(),
): SecretsMigrationResult {
  const state = readSecretsStoreState(stateDir);
  const envNow = readEnvEntries(stateDir);
  const moved: string[] = [];
  const left: string[] = [];

  for (const key of state.keychainKeys) {
    if (envNow.has(key)) {
      moved.push(key);
      continue;
    }
    const read = keychain.read(key);
    if (!read.ok) {
      left.push(key);
      continue;
    }
    if (read.value !== null) setDotenvFileKey(stateDir, key, read.value);
    moved.push(key);
  }

  writeSecretsStoreState(stateDir, {
    store: left.length > 0 ? "keychain" : "env",
    keychainKeys: left,
  });

  // Delete only after every value is safely in `.env`.
  const orphaned = moved.filter((key) => !keychain.remove(key));
  return {
    store: left.length > 0 ? "keychain" : "env",
    moved,
    left,
    orphaned,
    ok: left.length === 0,
  };
}
