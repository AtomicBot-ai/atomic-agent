import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeKeyring, type FakeKeyring } from "./fake-keyring-test-helpers.js";
import {
  SecretAccessError,
  readSavedSecret,
  saveSecret,
  secretNameError,
  secretValueError,
} from "./secret-access.js";
import {
  KEYCHAIN_SERVICE,
  readSecretsStoreState,
  SecretKeychain,
  writeSecretsStoreState,
} from "./secret-store.js";

/** One key at a time for the desktop app (ATO-1639), on top of ATO-474's store. */
describe("saveSecret / readSavedSecret", () => {
  let stateDir: string;
  let envPath: string;
  let fake: FakeKeyring;
  let keychain: SecretKeychain;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "secret-access-"));
    envPath = join(stateDir, ".env");
    fake = createFakeKeyring();
    keychain = new SecretKeychain(() => fake.module, () => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const held = (key: string): string | undefined =>
    fake.store.get(`${KEYCHAIN_SERVICE}/${key}`);

  it("accepts only secret-shaped names", () => {
    expect(secretNameError("OPENROUTER_API_KEY")).toBeNull();
    expect(secretNameError("TELEGRAM_BOT_TOKEN")).toBeNull();
    expect(secretNameError("PATH")).not.toBeNull();
    expect(secretNameError("NODE_OPTIONS")).not.toBeNull();
    expect(secretNameError("openai_api_key")).not.toBeNull();
    expect(() => saveSecret(stateDir, "NODE_OPTIONS", "--require x", keychain)).toThrow(
      SecretAccessError,
    );
    expect(existsSync(envPath)).toBe(false);
  });

  it("refuses an empty or multi-line value", () => {
    expect(secretValueError("")).not.toBeNull();
    expect(secretValueError("sk-1\nPATH=/tmp")).not.toBeNull();
    expect(() => saveSecret(stateDir, "OPENAI_API_KEY", "sk-1\nPATH=/tmp", keychain)).toThrow(
      SecretAccessError,
    );
    expect(existsSync(envPath)).toBe(false);
  });

  it(".env mode (the default) writes .env and never touches the keychain", () => {
    expect(saveSecret(stateDir, "OPENAI_API_KEY", "sk-1", keychain)).toEqual({ store: "env" });
    expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=sk-1\n");
    expect(fake.store.size).toBe(0);
    expect(readSavedSecret(stateDir, "OPENAI_API_KEY", keychain)).toEqual({
      ok: true,
      value: "sk-1",
      store: "env",
    });
  });

  it("keychain mode saves to the keychain and reads it back", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    expect(saveSecret(stateDir, "OPENROUTER_API_KEY", "sk-or-1", keychain)).toEqual({
      store: "keychain",
    });
    expect(held("OPENROUTER_API_KEY")).toBe("sk-or-1");
    expect(existsSync(envPath)).toBe(false);
    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual(["OPENROUTER_API_KEY"]);
    expect(readSavedSecret(stateDir, "OPENROUTER_API_KEY", keychain)).toEqual({
      ok: true,
      value: "sk-or-1",
      store: "keychain",
    });
  });

  it("says .env when the keychain failed and the value went to the fallback", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    fake.failWith = new Error("User canceled the operation.");
    expect(saveSecret(stateDir, "OPENROUTER_API_KEY", "sk-or-1", keychain)).toEqual({
      store: "env",
    });
    expect(readFileSync(envPath, "utf8")).toBe("OPENROUTER_API_KEY=sk-or-1\n");
  });

  it("a .env line wins over the keychain on read, as at load time", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["OPENAI_API_KEY"] });
    fake.store.set(`${KEYCHAIN_SERVICE}/OPENAI_API_KEY`, "sk-old");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-new\n");
    expect(readSavedSecret(stateDir, "OPENAI_API_KEY", keychain)).toMatchObject({
      value: "sk-new",
      store: "env",
    });
  });

  it("a key that is saved nowhere reads as null; an unreadable keychain as not ok", () => {
    expect(readSavedSecret(stateDir, "GEMINI_API_KEY", keychain)).toEqual({
      ok: true,
      value: null,
      store: "env",
    });
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: ["GEMINI_API_KEY"] });
    fake.failWith = new Error("denied");
    expect(readSavedSecret(stateDir, "GEMINI_API_KEY", keychain)).toEqual({ ok: false });
  });

  it("null removes the key from the keychain and its list", () => {
    writeSecretsStoreState(stateDir, { store: "keychain", keychainKeys: [] });
    saveSecret(stateDir, "OPENROUTER_API_KEY", "sk-or-1", keychain);
    expect(saveSecret(stateDir, "OPENROUTER_API_KEY", null, keychain)).toEqual({ store: "env" });
    expect(held("OPENROUTER_API_KEY")).toBeUndefined();
    expect(readSecretsStoreState(stateDir).keychainKeys).toEqual([]);
  });
});
