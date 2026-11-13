import type {
  KeyringEntry,
  KeyringEntryOptions,
  KeyringModule,
} from "../native/load-keyring.js";

/**
 * In-memory stand-in for `@napi-rs/keyring`, so the secrets-store tests
 * never touch the real OS keychain (or pop a macOS access dialog).
 * `failWith` makes every later call throw, like a denied keychain.
 */
export interface FakeKeyring {
  module: KeyringModule;
  /** `service/account` → secret. */
  store: Map<string, string>;
  /** Every Entry construction, in order. */
  opened: Array<{ service: string; account: string; options?: KeyringEntryOptions }>;
  calls: number;
  failWith: Error | null;
}

export function createFakeKeyring(): FakeKeyring {
  const fake: FakeKeyring = {
    module: undefined as unknown as KeyringModule,
    store: new Map(),
    opened: [],
    calls: 0,
    failWith: null,
  };
  const guard = (): void => {
    fake.calls += 1;
    if (fake.failWith) throw fake.failWith;
  };
  class Entry implements KeyringEntry {
    private readonly id: string;
    constructor(service: string, account: string, options?: KeyringEntryOptions) {
      guard();
      fake.opened.push({ service, account, options });
      this.id = `${service}/${account}`;
    }
    getPassword(): string | null {
      guard();
      return fake.store.get(this.id) ?? null;
    }
    setPassword(password: string): void {
      guard();
      fake.store.set(this.id, password);
    }
    deletePassword(): boolean {
      guard();
      if (!fake.store.has(this.id)) {
        throw new Error("No matching entry found in secure storage");
      }
      fake.store.delete(this.id);
      return true;
    }
  }
  fake.module = { Entry };
  return fake;
}
