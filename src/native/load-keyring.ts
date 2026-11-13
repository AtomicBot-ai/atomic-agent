/**
 * Lazy loader for `@napi-rs/keyring`, the OS credential store binding
 * (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 *
 * Same deployment shape as `better-sqlite3`: the package is external in
 * `scripts/bundle-sea.ts`, `scripts/package-bundle.ts` ships
 * `node_modules/@napi-rs/keyring` plus the host's prebuilt platform
 * package next to the SEA binary, and the load goes through CJS
 * `createRequire` anchored at the executable's directory.
 *
 * The load is synchronous because its only consumer, the secrets store
 * behind `loadDotenvFromStateDir`, runs inside the synchronous config
 * bootstrap. It never throws: a missing package, a platform without a
 * prebuild or a `.node` file the OS refuses to load all return `null`,
 * and the caller keeps secrets in `.env`. The keychain is opt-in
 * (`atomic-agent config secrets keychain`), so default installs never
 * reach this file.
 *
 * Only the surface the secrets store uses is typed here, so the agent
 * does not depend on the package's own declarations at compile time.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

/** One credential: `service` + `account` in the OS store. */
export interface KeyringEntry {
  /** The stored secret, or `null`/`undefined` when there is none. */
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  /** Removes the credential; resolves `false` (or throws) when absent. */
  deletePassword(): boolean | void;
}

export interface KeyringEntryOptions {
  /**
   * Linux only. `secret-service` makes the constructor throw when no
   * Secret Service (gnome-keyring, KWallet, ...) is running instead of
   * silently falling back to the kernel keyring, which does not survive
   * a reboot. Ignored on macOS and Windows.
   */
  linux?: { store?: "secret-service" | "keyutils" };
}

export interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
    options?: KeyringEntryOptions,
  ) => KeyringEntry;
}

const bootRequire = createRequire(import.meta.url);

function isRunningUnderSea(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

let cached: KeyringModule | null | undefined;

/**
 * The keyring binding, or `null` when it cannot be loaded on this
 * machine. The outcome is cached for the life of the process, so a
 * broken addon is probed once.
 */
export function loadKeyring(): KeyringModule | null {
  if (cached !== undefined) return cached;
  try {
    const req = isRunningUnderSea()
      ? createRequire(join(dirname(execPath), "__atomic_sea_anchor__.js"))
      : bootRequire;
    const mod = req("@napi-rs/keyring") as Partial<KeyringModule>;
    cached = typeof mod.Entry === "function" ? (mod as KeyringModule) : null;
  } catch {
    cached = null;
  }
  return cached;
}
