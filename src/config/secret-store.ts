import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  loadKeyring,
  type KeyringEntry,
  type KeyringModule,
} from "../native/load-keyring.js";
import { writeOwnerOnlyFileAtomicSync } from "./owner-only-file.js";

/**
 * Where saved secrets live: `.env` (the default, unchanged) or the OS
 * credential store (macOS Keychain, Windows Credential Manager, Linux
 * Secret Service), ATO-474.
 *
 * The choice and the names of the keys held in the keychain live in
 * `<stateDir>/secrets-store.json` rather than in `config.json`: the
 * dotenv writer and loader only know the state dir, run before the
 * config is parsed, and the OS stores have no "list my entries" call.
 * No file means `.env` mode, so a default install never touches the
 * keychain or loads the native binding. The file carries names only,
 * never values, and is written owner-only like `.env`.
 */
export type SecretsStoreKind = "env" | "keychain";

export const SECRETS_STORE_FILE = "secrets-store.json";

/** Keychain service name; the account is the env var name. */
export const KEYCHAIN_SERVICE = "atomic-agent";

export interface SecretsStoreState {
  store: SecretsStoreKind;
  /** Env var names currently held in the OS keychain. */
  keychainKeys: string[];
}

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Which `.env` names go to the keychain in keychain mode: API keys,
 * tokens, secrets and passwords. Everything else in `.env` (port and
 * timeout overrides and the like) stays in the file.
 */
export function isKeychainSecretName(name: string): boolean {
  return KEY_PATTERN.test(name) && /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(name);
}

export function secretsStorePath(stateDir: string): string {
  return join(stateDir, SECRETS_STORE_FILE);
}

function warnDefault(message: string): void {
  process.stderr.write(`atomic-agent: ${message}\n`);
}

/**
 * Read the store choice. A missing file is `.env` mode. A file that
 * cannot be parsed is reported once on stderr and treated as `.env`
 * mode with no keychain keys, which never writes anything.
 */
export function readSecretsStoreState(
  stateDir: string,
  warn: (message: string) => void = warnDefault,
): SecretsStoreState {
  const path = secretsStorePath(stateDir);
  if (!existsSync(path)) return { store: "env", keychainKeys: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      store?: unknown;
      keychainKeys?: unknown;
    };
    const store: SecretsStoreKind = raw.store === "keychain" ? "keychain" : "env";
    const keys = Array.isArray(raw.keychainKeys)
      ? raw.keychainKeys.filter(
          (k): k is string => typeof k === "string" && KEY_PATTERN.test(k),
        )
      : [];
    return { store, keychainKeys: [...new Set(keys)] };
  } catch {
    warn(
      `could not read ${path}; keys saved in the OS keychain were not loaded. Fix or remove the file.`,
    );
    return { store: "env", keychainKeys: [] };
  }
}

/**
 * Persist the store choice. `.env` mode with nothing left in the
 * keychain removes the file, so the state dir looks exactly like it
 * did before the keychain was ever enabled.
 */
export function writeSecretsStoreState(
  stateDir: string,
  state: SecretsStoreState,
): void {
  const path = secretsStorePath(stateDir);
  if (state.store === "env" && state.keychainKeys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const payload = {
    store: state.store,
    keychainKeys: [...new Set(state.keychainKeys)],
  };
  writeOwnerOnlyFileAtomicSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export type KeychainRead = { ok: true; value: string | null } | { ok: false };

/** keyring-rs reports a missing credential as an error with this text. */
const NO_ENTRY = /no matching entry/i;

/**
 * The OS keychain, with Jan's fallback rule: the first failure of any
 * kind (binding missing, no Secret Service, access denied in the macOS
 * dialog, ...) is reported once and turns the keychain off for the
 * rest of the process, so callers fall back to `.env` and the user is
 * not shown one system dialog per key. Values never reach the warning.
 */
export class SecretKeychain {
  private failed = false;

  constructor(
    private readonly loadModule: () => KeyringModule | null = loadKeyring,
    private readonly warn: (message: string) => void = warnDefault,
  ) {}

  /** False once anything failed in this process. */
  get usable(): boolean {
    return !this.failed;
  }

  read(name: string): KeychainRead {
    const entry = this.entry(name);
    if (!entry) return { ok: false };
    try {
      const value = entry.getPassword();
      return { ok: true, value: typeof value === "string" ? value : null };
    } catch (err) {
      if (NO_ENTRY.test(errorText(err))) return { ok: true, value: null };
      this.fail(err);
      return { ok: false };
    }
  }

  write(name: string, value: string): boolean {
    const entry = this.entry(name);
    if (!entry) return false;
    try {
      entry.setPassword(value);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** True when the credential is gone afterwards (absent counts). */
  remove(name: string): boolean {
    const entry = this.entry(name);
    if (!entry) return false;
    try {
      entry.deletePassword();
      return true;
    } catch (err) {
      if (NO_ENTRY.test(errorText(err))) return true;
      this.fail(err);
      return false;
    }
  }

  private entry(name: string): KeyringEntry | null {
    if (this.failed) return null;
    const mod = this.loadModule();
    if (!mod) {
      this.fail(new Error("the keychain binding could not be loaded"));
      return null;
    }
    try {
      return new mod.Entry(KEYCHAIN_SERVICE, name, {
        linux: { store: "secret-service" },
      });
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.warn(
      `the OS keychain is unavailable (${errorText(err)}); saved keys use .env for the rest of this run.`,
    );
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/)[0]?.slice(0, 200) ?? "";
}

let shared: SecretKeychain | null = null;

/**
 * The process-wide keychain the writer and loader share by default, so
 * a failure seen at bootstrap also sends later writes to `.env`. This
 * is the documented session-scoped fallback state (like the config
 * cache); tests pass their own `SecretKeychain` instead.
 */
export function defaultSecretKeychain(): SecretKeychain {
  shared ??= new SecretKeychain();
  return shared;
}

export interface KeychainLoadResult {
  loaded: string[];
  skipped: string[];
  /** Listed in the keychain but could not be read this run. */
  unavailable: string[];
}

/**
 * Apply keychain-held secrets to `process.env`, after `.env` has been
 * applied: anything already set (the shell, or a `.env` line written
 * while the keychain was failing, which is the newer value) wins.
 * Returns `null` in `.env` mode, the default.
 */
export function loadKeychainSecrets(
  stateDir: string,
  keychain: SecretKeychain = defaultSecretKeychain(),
  env: NodeJS.ProcessEnv = process.env,
): KeychainLoadResult | null {
  const state = readSecretsStoreState(stateDir);
  if (state.store !== "keychain" || state.keychainKeys.length === 0) return null;
  const result: KeychainLoadResult = { loaded: [], skipped: [], unavailable: [] };
  for (const key of state.keychainKeys) {
    const existing = env[key];
    if (existing !== undefined && existing.length > 0) {
      result.skipped.push(key);
      continue;
    }
    const read = keychain.read(key);
    if (!read.ok) {
      result.unavailable.push(key);
      continue;
    }
    if (read.value === null) continue;
    env[key] = read.value;
    result.loaded.push(key);
  }
  if (result.unavailable.length > 0) {
    warnDefault(
      `keys saved in the OS keychain were not loaded this run: ${result.unavailable.join(", ")}.`,
    );
  }
  return result;
}
