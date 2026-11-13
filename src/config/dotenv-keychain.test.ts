import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDotenvKey } from "./dotenv-writer.js";
import { createFakeKeyring, type FakeKeyring } from "./fake-keyring-test-helpers.js";
import { loadDotenvFromStateDir } from "./load-dotenv.js";
import {
  KEYCHAIN_SERVICE,
  readSecretsStoreState,
  SecretKeychain,
  secretsStorePath,
  writeSecretsStoreState,
} from "./secret-store.js";

/** setDotenvKey / loadDotenvFromStateDir with the opt-in OS keychain (ATO-474). */
describe("dotenv with the OS keychain", () => {
  const KEYS = ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "ATOMIC_KC_TEST_PORT"];
  let stateDir: string;
  let envPath: string;
  let fake: FakeKeyring;
  let loads: number;
  let keychain: SecretKeychain;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "dotenv-keychain-"));
    envPath = join(stateDir, ".env");
    fake = createFakeKeyring();
    loads = 0;
    keychain = new SecretKeychain(
      () => {
        loads += 1;
        return fake.module;
      },
      () => {},
    );
    for (const k of KEYS) delete process.env[k];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    for (const k of KEYS) delete process.env[k];
  });

  const held = (key: string): string | undefined =>
    fake.store.get(`${KEYCHAIN_SERVICE}/${key}`);

  it("default mode is unchanged: .env only, binding never loaded", () => {
    setDotenvKey(stateDir, "OPENAI_API_KEY", "sk-1", keychain);
    expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=sk-1\n");
    expect(existsSync(secretsStorePath(stateDir))).toBe(false);
    loadDotenvFromStateDir(stateDir, { keychain });
    expect(process.env.OPENAI_API_KEY).toBe("sk-1");
    expect(loads).toBe(0);
  });

  it("keychain mode stores secrets in the keychain, not in .env", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    writeFileSync(envPath, "# mine\nOPENAI_API_KEY=old\nATOMIC_KC_TEST_PORT=9000\n");

    const result = setDotenvKey(stateDir, "OPENAI_API_KEY", "sk-new", keychain);

    expect(result.changed).toBe(true);
    expect(held("OPENAI_API_KEY")).toBe("sk-new");
    expect(readFileSync(envPath, "utf8")).toBe("# mine\nATOMIC_KC_TEST_PORT=9000\n");
    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual(["OPENAI_API_KEY"]);
  });

  it("keeps settings that are not secrets in .env", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    setDotenvKey(stateDir, "ATOMIC_KC_TEST_PORT", "9000", keychain);
    expect(readFileSync(envPath, "utf8")).toBe("ATOMIC_KC_TEST_PORT=9000\n");
    expect(fake.store.size).toBe(0);
  });

  it("loads keychain secrets at bootstrap even with no .env", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "123:abc", keychain);
    expect(existsSync(envPath)).toBe(false);

    const result = loadDotenvFromStateDir(stateDir, { keychain });

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(result.loaded).toEqual(["TELEGRAM_BOT_TOKEN"]);
    expect(result.keychain?.loaded).toEqual(["TELEGRAM_BOT_TOKEN"]);
  });

  it("falls back to .env when the keychain fails, and stays there", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    fake.failWith = new Error("denied");

    setDotenvKey(stateDir, "OPENAI_API_KEY", "sk-1", keychain);
    fake.failWith = null;
    setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "123:abc", keychain);

    expect(readFileSync(envPath, "utf8")).toBe(
      "OPENAI_API_KEY=sk-1\nTELEGRAM_BOT_TOKEN=123:abc\n",
    );
    expect(fake.store.size).toBe(0);
    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual([]);
  });

  it("a .env line written during a fallback wins over the older keychain value", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["OPENAI_API_KEY"] });
    fake.store.set(`${KEYCHAIN_SERVICE}/OPENAI_API_KEY`, "sk-old");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-newer\n");

    loadDotenvFromStateDir(stateDir, { keychain });

    expect(process.env.OPENAI_API_KEY).toBe("sk-newer");
  });

  it("removing a key deletes it from the keychain and the list", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    setDotenvKey(stateDir, "OPENAI_API_KEY", "sk-1", keychain);

    const result = setDotenvKey(stateDir, "OPENAI_API_KEY", null, keychain);

    expect(result.changed).toBe(true);
    expect(held("OPENAI_API_KEY")).toBeUndefined();
    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual([]);
    loadDotenvFromStateDir(stateDir, { keychain });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("a key whose keychain delete fails is still never loaded again", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["OPENAI_API_KEY"] });
    fake.store.set(`${KEYCHAIN_SERVICE}/OPENAI_API_KEY`, "sk-1");
    fake.failWith = new Error("locked");

    setDotenvKey(stateDir, "OPENAI_API_KEY", null, keychain);

    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual([]);
  });
});
