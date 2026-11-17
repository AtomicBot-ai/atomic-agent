/* ---------------------------------------------------------------
   ATO-1639 — provider keys and bot tokens in the OS keychain, through
   the agent.

   The agent can keep saved keys in the OS keychain (macOS Keychain,
   Windows Credential Manager, Linux Secret Service) since ATO-474, opt-in
   with `atag config secrets keychain`; `.env` stays the default. The app
   did not know: it wrote keys into config.json and `.env` itself, so with
   the keychain on its keys stayed in plaintext, and keys the terminal had
   put in the keychain looked missing here.

   The app never opens the keychain itself. A second implementation would
   be a second app asking macOS for each key (the keychain asks per app),
   and could drift from the agent's rules. Instead, like Claude Code and
   Codex keeping one credential store per tool, everything goes through
   the agent:

   - which store is on, and the NAMES the keychain holds, are read from
     the agent's own `<stateDir>/secrets-store.json` (names only, never a
     value, and no keychain access);
   - a key is saved with `PUT /api/secrets/{name}` while `atag serve` is up
     (the running agent also starts using it at once), else with
     `atag config secrets set <NAME>`, the value on stdin;
   - a value the app needs (the key check, the OpenRouter catalog) is read
     with `atag config secrets get <NAME>` and kept for a minute.

   With the default `.env` store none of this runs: every path below
   answers "not keychain" and the callers do what they did before. An agent
   older than these commands answers "unknown", and the app falls back to
   what it did before as well.

   No Electron here; agent-cli.ts hands in the agent calls, so the unit
   test drives this with stand-ins.
   --------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SECRETS_STORE_FILE = "secrets-store.json";

export type SecretsStoreKind = "env" | "keychain";

export interface SecretsStoreState {
  store: SecretsStoreKind;
  /** Env var names the agent holds in the OS keychain. */
  keychainKeys: string[];
}

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** src/config/secret-store.ts isKeychainSecretName: what the agent sends to the keychain in keychain mode. */
export function isKeychainSecretName(name: string): boolean {
  return KEY_PATTERN.test(name) && /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(name);
}

/**
 * src/config/secret-store.ts readSecretsStoreState, without its warning: a
 * missing or unreadable file is `.env` mode with nothing in the keychain,
 * which makes every caller here behave as before.
 */
export function readSecretsStore(stateDir: string): SecretsStoreState {
  let raw: { store?: unknown; keychainKeys?: unknown };
  try {
    raw = JSON.parse(readFileSync(join(stateDir, SECRETS_STORE_FILE), "utf8")) as typeof raw;
  } catch {
    return { store: "env", keychainKeys: [] };
  }
  if (!raw || typeof raw !== "object") return { store: "env", keychainKeys: [] };
  const store: SecretsStoreKind = raw.store === "keychain" ? "keychain" : "env";
  const keys = Array.isArray(raw.keychainKeys)
    ? raw.keychainKeys.filter((k): k is string => typeof k === "string" && KEY_PATTERN.test(k))
    : [];
  return { store, keychainKeys: [...new Set(keys)] };
}

/** True when the agent saves keys in the OS keychain (opt-in, ATO-474). */
export function keychainStoreOn(stateDir: string): boolean {
  return readSecretsStore(stateDir).store === "keychain";
}

/** The names the agent loads from the keychain at start: none unless keychain mode is on (load-dotenv.ts loadKeychainSecrets). */
export function keychainHeldNames(stateDir: string): string[] {
  const state = readSecretsStore(stateDir);
  return state.store === "keychain" ? state.keychainKeys : [];
}

export const PROVIDER_KEY_PREFIX = "ATOMIC_AGENT_PROVIDER_";

/**
 * The variable a provider key typed in the window is saved under when the
 * keychain is on: one of its own per provider. A shared or well-known name
 * (OPENAI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY) is not used: two
 * providers would share one key, and the same name set in this app's
 * environment would win over the keychain in the agent's loader
 * (load-dotenv.ts), quietly shadowing the key just typed. An entry already
 * saved this way keeps its name.
 */
export function keychainProviderEnvVar(entry: { id: string; apiKeyEnvVar?: string }): string {
  const own = entry.apiKeyEnvVar;
  if (own && own.startsWith(PROVIDER_KEY_PREFIX) && isKeychainSecretName(own)) return own;
  const id = entry.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CUSTOM";
  return `${PROVIDER_KEY_PREFIX}${id}_API_KEY`;
}

/* ---- the agent calls ---------------------------------------------- */

export interface AgentCliAnswer {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
}

/** `PUT /api/secrets/{name}` on the running agent: null when there is none, or it is older than the route. */
export type SecretsRoute = (name: string, value: string | null) => Promise<
  { ok: true; store: SecretsStoreKind } | { ok: false; error: string } | null
>;

export interface KeychainDeps {
  /** `atag <args>`, `input` on stdin (agent-cli.ts `cli`). */
  cli: (args: string[], input?: string, timeoutMs?: number) => Promise<AgentCliAnswer>;
  /** The running agent's route, while there is one on this computer. */
  route?: SecretsRoute | null;
}

export type SaveThroughAgent =
  | { ok: true; store: SecretsStoreKind }
  /** `unsupported`: the agent does not know these commands; the caller does what it did before. */
  | { ok: false; unsupported: boolean; error: string };

/** What an agent from before ATO-1639 says to `config secrets set|get|unset`. */
function unsupportedAnswer(res: AgentCliAnswer): boolean {
  return /unknown secrets subcommand|unknown subcommand/i.test(`${res.stderr}\n${res.error ?? ""}`);
}

/** Save (or with null remove) one key wherever the agent keeps keys. The value is never logged or returned. */
export async function saveSecretThroughAgent(deps: KeychainDeps, name: string, value: string | null): Promise<SaveThroughAgent> {
  if (!isKeychainSecretName(name)) return { ok: false, unsupported: false, error: `not a key name: ${name}` };
  if (value !== null && (value.length === 0 || /[\r\n\0]/.test(value))) {
    return { ok: false, unsupported: false, error: "value must be one line" };
  }
  if (deps.route) {
    const viaRoute = await deps.route(name, value);
    if (viaRoute) {
      if (viaRoute.ok) forget(name, value);
      return viaRoute.ok ? viaRoute : { ok: false, unsupported: false, error: viaRoute.error };
    }
  }
  const res = value === null
    ? await deps.cli(["config", "secrets", "unset", name])
    : await deps.cli(["config", "secrets", "set", name, "--json"], `${value}\n`);
  if (!res.ok) {
    return { ok: false, unsupported: unsupportedAnswer(res), error: res.error ?? "the agent could not save the key" };
  }
  let store: SecretsStoreKind = "env";
  try {
    store = (JSON.parse(res.stdout) as { store?: unknown }).store === "keychain" ? "keychain" : "env";
  } catch {
    /* `unset` prints a sentence; a value went nowhere but out of the stores */
  }
  forget(name, value);
  return { ok: true, store };
}

/* ---- values the app needs ----------------------------------------- */

/** A value read from the agent is kept this long, so a burst of checks asks it once. */
export const KEYCHAIN_VALUE_TTL_MS = 60_000;
const values = new Map<string, { value: string; at: number }>();

function forget(name: string, value: string | null): void {
  if (value === null) values.delete(name);
  else values.set(name, { value, at: Date.now() });
}

/** The value read or written within the last minute, or undefined. Never logged. */
export function cachedKeychainValue(name: string, now: number = Date.now()): string | undefined {
  const hit = values.get(name);
  if (!hit) return undefined;
  if (now - hit.at > KEYCHAIN_VALUE_TTL_MS) {
    values.delete(name);
    return undefined;
  }
  return hit.value;
}

/** Test seam, and what a folder change calls: nothing read before is kept. */
export function clearKeychainValues(): void {
  values.clear();
}

/**
 * The saved value of a keychain-held name, through `atag config secrets get`.
 * Null when it is not held there, not saved, or the agent could not read it
 * (the keychain refused): the caller treats that as "no key", as it would a
 * missing `.env` line.
 */
export async function readKeychainValue(deps: KeychainDeps, stateDir: string, name: string): Promise<string | null> {
  if (!keychainHeldNames(stateDir).includes(name)) return null;
  const cached = cachedKeychainValue(name);
  if (cached !== undefined) return cached;
  // A macOS keychain dialog may be waiting for the person: give it time.
  const res = await deps.cli(["config", "secrets", "get", name], undefined, 120_000);
  if (!res.ok) return null;
  const value = res.stdout.replace(/\r?\n$/, "");
  if (!value) return null;
  values.set(name, { value, at: Date.now() });
  return value;
}
