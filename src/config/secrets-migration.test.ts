import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeKeyring, type FakeKeyring } from "./fake-keyring-test-helpers.js";
import {
  KEYCHAIN_SERVICE,
  readSecretsStoreState,
  SecretKeychain,
  secretsStorePath,
} from "./secret-store.js";
import { moveSecretsToEnv, moveSecretsToKeychain } from "./secrets-migration.js";

describe("secrets migration", () => {
  let stateDir: string;
  let envPath: string;
  let fake: FakeKeyring;
  const keychain = (): SecretKeychain => new SecretKeychain(() => fake.module, () => {});

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "secrets-migration-"));
    envPath = join(stateDir, ".env");
    fake = createFakeKeyring();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const held = (key: string): string | undefined =>
    fake.store.get(`${KEYCHAIN_SERVICE}/${key}`);

  it("moves API keys and tokens to the keychain and keeps settings in .env", () => {
    writeFileSync(
      envPath,
      "# keep me\nOPENAI_API_KEY=sk-1\nTELEGRAM_BOT_TOKEN='123:a b'\nATOMIC_AGENT_LLAMA_MAX_TOKENS=4096\n",
    );

    const result = moveSecretsToKeychain(stateDir, keychain());

    expect(result).toMatchObject({
      store: "keychain",
      moved: ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"],
      left: [],
      ok: true,
    });
    expect(held("OPENAI_API_KEY")).toBe("sk-1");
    expect(held("TELEGRAM_BOT_TOKEN")).toBe("123:a b");
    expect(readFileSync(envPath, "utf8")).toBe(
      "# keep me\nATOMIC_AGENT_LLAMA_MAX_TOKENS=4096\n",
    );
    expect(readSecretsStoreState(stateDir)).toEqual({
      store: "keychain",
      keychainKeys: ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"],
    });
  });

  it("does not switch when the keychain does not work", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-1\n");
    fake.failWith = new Error("no Secret Service");

    const result = moveSecretsToKeychain(stateDir, keychain());

    expect(result).toMatchObject({ store: "env", moved: [], left: ["OPENAI_API_KEY"], ok: false });
    expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=sk-1\n");
    expect(existsSync(secretsStorePath(stateDir))).toBe(false);
  });

  it("probes the keychain when there is nothing to move yet", () => {
    const result = moveSecretsToKeychain(stateDir, keychain());
    expect(result).toMatchObject({ store: "keychain", moved: [], ok: true });
    expect(fake.store.size).toBe(0);
    expect(readSecretsStoreState(stateDir).store).toBe("keychain");
  });

  it("moves everything back to .env and restores the default", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-1\nGITHUB_TOKEN=ghp_x\n");
    moveSecretsToKeychain(stateDir, keychain());

    const result = moveSecretsToEnv(stateDir, keychain());

    expect(result).toMatchObject({ store: "env", left: [], orphaned: [], ok: true });
    expect(result.moved.sort()).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("OPENAI_API_KEY=sk-1\n");
    expect(text).toContain("GITHUB_TOKEN=ghp_x\n");
    expect(fake.store.size).toBe(0);
    expect(existsSync(secretsStorePath(stateDir))).toBe(false);
  });

  it("keeps a newer .env line when moving back", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-1\n");
    moveSecretsToKeychain(stateDir, keychain());
    writeFileSync(envPath, "OPENAI_API_KEY=sk-newer\n");

    moveSecretsToEnv(stateDir, keychain());

    expect(readFileSync(envPath, "utf8")).toBe("OPENAI_API_KEY=sk-newer\n");
    expect(held("OPENAI_API_KEY")).toBeUndefined();
  });

  it("leaves unreadable keys listed in the keychain", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-1\n");
    moveSecretsToKeychain(stateDir, keychain());
    fake.failWith = new Error("denied");

    const result = moveSecretsToEnv(stateDir, keychain());

    expect(result).toMatchObject({ store: "keychain", moved: [], left: ["OPENAI_API_KEY"], ok: false });
    expect(readSecretsStoreState(stateDir)).toEqual({
      store: "keychain",
      keychainKeys: ["OPENAI_API_KEY"],
    });
  });
});
