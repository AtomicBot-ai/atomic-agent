import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { applySavedSecretToEnv, applySavedSecretToEnvAsync } from "./apply-saved-secret.js";
import { listSavedSecretRefs, secretRefSource } from "./saved-secret-refs.js";
import {
  resetSecretRefCache,
  resolveSecretRefSync,
  type SecretSpawnOutcome,
} from "./secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES } from "./secret-refs.js";
import type { SecretKeychain } from "./secret-store.js";

// ATO-2530: a key saved mid-session as a reference reaches the running
// agent as its value. `op` is faked; nothing real runs.
const VALUE = "Op9Resolved8Value7";
const ok = (): SecretSpawnOutcome => ({ stdout: `${VALUE}\n`, stderr: "", exitCode: 0, failure: null });

describe("applySavedSecretToEnv", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-secret-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetSecretRefCache();
    resetResolvedSecretValues();
  });

  it("puts the resolved value in the environment for a reference", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const argv: string[][] = [];
    const out = applySavedSecretToEnv(dir, "OPENROUTER_API_KEY", "op://Private/OR/credential", {
      env,
      spawn: (a) => {
        argv.push([...a]);
        return ok();
      },
    });
    expect(out).toEqual({ resolved: true });
    expect(env.OPENROUTER_API_KEY).toBe(VALUE);
    expect(argv[0]).toEqual(["op", "read", "op://Private/OR/credential"]);
  });

  it("leaves the variable unset (never the reference) when it cannot be read", () => {
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "old" };
    const out = applySavedSecretToEnv(dir, "OPENROUTER_API_KEY", "op://Private/OR/credential", {
      env,
      spawn: () => ({ stdout: "", stderr: "not signed in", exitCode: 1, failure: null }),
    });
    expect(out.resolved).toBe(false);
    expect(out.error).toMatch(/^OPENROUTER_API_KEY: /);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  // Review round 1 (F2102.4): the key was rotated in 1Password and the same
  // reference is saved again to pick it up. The save reads it again instead
  // of the cached old value.
  it("reads a reference saved again instead of the cached old value", async () => {
    const REF = "op://Private/OR/credential";
    const said = (v: string) => (): SecretSpawnOutcome => ({ stdout: `${v}\n`, stderr: "", exitCode: 0, failure: null });
    expect(resolveSecretRefSync("OPENROUTER_API_KEY", REF, { sources: EMPTY_SECRET_SOURCES, spawn: said("old-key-1") })).toBe(
      "old-key-1",
    );
    const env: NodeJS.ProcessEnv = {};
    expect(applySavedSecretToEnv(dir, "OPENROUTER_API_KEY", REF, { env, spawn: said("new-key-2") })).toEqual({
      resolved: true,
    });
    expect(env.OPENROUTER_API_KEY).toBe("new-key-2");
    const asyncEnv: NodeJS.ProcessEnv = {};
    await applySavedSecretToEnvAsync(dir, "OPENROUTER_API_KEY", REF, {
      env: asyncEnv,
      spawn: async () => said("new-key-3")(),
    });
    expect(asyncEnv.OPENROUTER_API_KEY).toBe("new-key-3");
  });

  it("sets a plain value as it is and removes on null", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applySavedSecretToEnv(dir, "X_API_KEY", "sk-plain", { env })).toEqual({ resolved: false });
    expect(env.X_API_KEY).toBe("sk-plain");
    applySavedSecretToEnv(dir, "X_API_KEY", null, { env });
    expect(env.X_API_KEY).toBeUndefined();
  });
});

describe("saved reference sources", () => {
  it("names each scheme and nothing for a plain value", () => {
    expect(secretRefSource("op://a/b/c")).toBe("1password");
    expect(secretRefSource("bw://a/password")).toBe("bitwarden");
    expect(secretRefSource("vault://secret/a#b")).toBe("vault");
    expect(secretRefSource("cmd://k")).toBe("command");
    expect(secretRefSource("sk-or-v1-abc")).toBeNull();
  });

  it("lists .env references first, then keychain ones .env does not hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "saved-refs-"));
    try {
      writeFileSync(join(dir, ".env"), "A_API_KEY=op://v/i/f\nB_API_KEY=sk-plain\n");
      writeFileSync(
        join(dir, "secrets-store.json"),
        JSON.stringify({ store: "keychain", keychainKeys: ["A_API_KEY", "C_TOKEN", "D_TOKEN"] }),
      );
      const values: Record<string, string> = { A_API_KEY: "bw://other/password", C_TOKEN: "vault://kv/x#t", D_TOKEN: "plain" };
      const keychain = { read: (name: string) => ({ ok: true, value: values[name] ?? null }) } as unknown as SecretKeychain;
      expect(listSavedSecretRefs(dir, keychain)).toEqual([
        { name: "A_API_KEY", ref: "op://v/i/f", source: "1password", store: "env" },
        { name: "C_TOKEN", ref: "vault://kv/x#t", source: "vault", store: "keychain" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
