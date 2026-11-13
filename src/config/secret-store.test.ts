import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeKeyring, type FakeKeyring } from "./fake-keyring-test-helpers.js";
import {
  isKeychainSecretName,
  KEYCHAIN_SERVICE,
  loadKeychainSecrets,
  readSecretsStoreState,
  SecretKeychain,
  secretsStorePath,
  writeSecretsStoreState,
} from "./secret-store.js";

describe("isKeychainSecretName", () => {
  it("takes API keys, tokens, secrets and passwords", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "GITHUB_TOKEN",
      "ATOMIC_AGENT_LLAMA_API_KEY",
      "SOME_CLIENT_SECRET",
      "DB_PASSWORD",
    ]) {
      expect(isKeychainSecretName(name)).toBe(true);
    }
  });

  it("leaves settings and malformed names in .env", () => {
    for (const name of ["ATOMIC_AGENT_LLAMA_MAX_TOKENS", "PORT", "API_KEY_FILE", "openai_api_key", "KEY"]) {
      expect(isKeychainSecretName(name)).toBe(false);
    }
  });
});

describe("secrets-store.json", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "secret-store-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is .env mode when the file is missing", () => {
    expect(readSecretsStoreState(stateDir)).toEqual({ store: "env", keychainKeys: [] });
  });

  it("round-trips keychain mode and key names, owner-only", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["A_KEY", "A_KEY", "B_TOKEN"] });
    expect(readSecretsStoreState(stateDir)).toEqual({ store: "keychain", keychainKeys: ["A_KEY", "B_TOKEN"] });
    if (process.platform !== "win32") {
      expect(statSync(secretsStorePath(stateDir)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes the file when back to .env with nothing in the keychain", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    expect(existsSync(secretsStorePath(stateDir))).toBe(true);
    writeSecretsStoreState(stateDir, { store: "env", keychainKeys: [] });
    expect(existsSync(secretsStorePath(stateDir))).toBe(false);
  });

  it("treats a broken file as .env mode and warns once", () => {
    writeFileSync(secretsStorePath(stateDir), "{nope");
    const warnings: string[] = [];
    expect(readSecretsStoreState(stateDir, (m) => warnings.push(m))).toEqual({
      store: "env",
      keychainKeys: [],
    });
    expect(warnings).toHaveLength(1);
  });
});

describe("SecretKeychain", () => {
  let fake: FakeKeyring;
  let warnings: string[];
  let keychain: SecretKeychain;
  beforeEach(() => {
    fake = createFakeKeyring();
    warnings = [];
    keychain = new SecretKeychain(() => fake.module, (m) => warnings.push(m));
  });

  it("stores under the atomic-agent service, pinned to the Linux Secret Service", () => {
    expect(keychain.write("OPENAI_API_KEY", "sk-1")).toBe(true);
    expect(fake.store.get(`${KEYCHAIN_SERVICE}/OPENAI_API_KEY`)).toBe("sk-1");
    expect(fake.opened[0]?.options).toEqual({ linux: { store: "secret-service" } });
    expect(keychain.read("OPENAI_API_KEY")).toEqual({ ok: true, value: "sk-1" });
  });

  it("reads a missing entry as null and removing it as done", () => {
    expect(keychain.read("NONE_KEY")).toEqual({ ok: true, value: null });
    expect(keychain.remove("NONE_KEY")).toBe(true);
    expect(keychain.usable).toBe(true);
  });

  it("turns itself off after the first failure and warns once, without the value", () => {
    fake.failWith = new Error("User interaction is not allowed.");
    expect(keychain.write("OPENAI_API_KEY", "sk-secret")).toBe(false);
    const callsAfterFailure = fake.calls;
    expect(keychain.read("OPENAI_API_KEY")).toEqual({ ok: false });
    expect(keychain.write("OTHER_TOKEN", "t")).toBe(false);
    // No further system calls (no second macOS dialog) once it failed.
    expect(fake.calls).toBe(callsAfterFailure);
    expect(keychain.usable).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("sk-secret");
  });

  it("fails soft when the binding cannot be loaded", () => {
    const missing = new SecretKeychain(() => null, (m) => warnings.push(m));
    expect(missing.write("OPENAI_API_KEY", "sk-1")).toBe(false);
    expect(missing.read("OPENAI_API_KEY")).toEqual({ ok: false });
    expect(warnings).toHaveLength(1);
  });
});

describe("loadKeychainSecrets", () => {
  let stateDir: string;
  let fake: FakeKeyring;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "secret-load-"));
    fake = createFakeKeyring();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("does nothing in .env mode and never loads the binding", () => {
    let loads = 0;
    const keychain = new SecretKeychain(() => {
      loads += 1;
      return fake.module;
    });
    expect(loadKeychainSecrets(stateDir, keychain, {})).toBeNull();
    expect(loads).toBe(0);
  });

  it("applies listed keys without overriding values already set", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["A_KEY", "B_TOKEN", "GONE_KEY"] });
    fake.store.set(`${KEYCHAIN_SERVICE}/A_KEY`, "from-keychain");
    fake.store.set(`${KEYCHAIN_SERVICE}/B_TOKEN`, "old");
    const env: NodeJS.ProcessEnv = { B_TOKEN: "from-env-file" };
    const result = loadKeychainSecrets(stateDir, new SecretKeychain(() => fake.module), env);
    expect(env.A_KEY).toBe("from-keychain");
    expect(env.B_TOKEN).toBe("from-env-file");
    expect(result).toEqual({ loaded: ["A_KEY"], skipped: ["B_TOKEN"], unavailable: [] });
  });

  it("reports keys it could not read", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["A_KEY", "B_TOKEN"] });
    fake.failWith = new Error("no Secret Service");
    const env: NodeJS.ProcessEnv = {};
    const result = loadKeychainSecrets(
      stateDir,
      new SecretKeychain(() => fake.module, () => {}),
      env,
    );
    expect(result?.unavailable).toEqual(["A_KEY", "B_TOKEN"]);
    expect(env.A_KEY).toBeUndefined();
  });
});
