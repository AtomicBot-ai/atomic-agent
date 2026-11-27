import { afterEach, describe, expect, it } from "vitest";

import {
  resetResolvedSecretValues,
  resolvedSecretValues,
} from "../sandbox/resolved-secret-values.js";
import {
  resetSecretRefCache,
  resolveSecretRef,
  resolveSecretRefSync,
  SECRET_REF_MAX_OUTPUT_BYTES,
  type SecretSpawnOptions,
  type SecretSpawnOutcome,
} from "./secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES, SECRET_KEY_ENV, type SecretSources } from "./secret-refs.js";

const VALUE = "Live9Secret8Value7";

type Call = { argv: readonly string[]; options: SecretSpawnOptions };

function fake(outcome: Partial<SecretSpawnOutcome>, calls: Call[] = []) {
  const full: SecretSpawnOutcome = { stdout: "", stderr: "", exitCode: 0, failure: null, ...outcome };
  return {
    calls,
    sync: (argv: readonly string[], options: SecretSpawnOptions) => {
      calls.push({ argv, options });
      return full;
    },
    async: async (argv: readonly string[], options: SecretSpawnOptions) => {
      calls.push({ argv, options });
      return full;
    },
  };
}

const ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  OPENROUTER_API_KEY: "sk-or-v1-should-not-reach-the-child-0000",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_token_for_op_itself_123",
  BW_CLIENTSECRET: "bw-client-secret-456",
  VAULT_TOKEN: "hvs.vault-token-789",
};

afterEach(() => {
  resetSecretRefCache();
  resetResolvedSecretValues();
});

describe("resolveSecretRefSync / resolveSecretRef", () => {
  it("runs op read with the reference as one argv entry and keeps only OP_ variables of the secrets", () => {
    const f = fake({ stdout: `${VALUE}\n` });
    const value = resolveSecretRefSync("DEPLOY_TOKEN", "op://Private/Deploy/credential", {
      sources: EMPTY_SECRET_SOURCES,
      env: ENV,
      spawn: f.sync,
    });
    expect(value).toBe(VALUE);
    expect(f.calls[0]!.argv).toEqual(["op", "read", "op://Private/Deploy/credential"]);
    const childEnv = f.calls[0]!.options.env;
    expect(childEnv.OP_SERVICE_ACCOUNT_TOKEN).toBe(ENV.OP_SERVICE_ACCOUNT_TOKEN);
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
    expect(childEnv.BW_CLIENTSECRET).toBeUndefined();
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(f.calls[0]!.options.timeoutMs).toBe(3_000);
    expect(f.calls[0]!.options.maxBytes).toBe(SECRET_REF_MAX_OUTPUT_BYTES);
  });

  it("runs bw get <field> <item> for bw://", async () => {
    const f = fake({ stdout: VALUE });
    await resolveSecretRef("NPM_TOKEN", "bw://npm publish/password", {
      sources: EMPTY_SECRET_SOURCES,
      env: ENV,
      spawn: f.async,
    });
    expect(f.calls[0]!.argv).toEqual(["bw", "get", "password", "npm publish"]);
    expect(f.calls[0]!.options.env.BW_CLIENTSECRET).toBe(ENV.BW_CLIENTSECRET);
  });

  it("passes the cmd:// key to the helper as ATOMIC_AGENT_SECRET_KEY, never as an argument", async () => {
    const sources: SecretSources = {
      ...EMPTY_SECRET_SOURCES,
      command: ["/opt/helper", "get"],
      envPassthrough: ["VAULT_TOKEN"],
      timeoutMs: 1_500,
    };
    const f = fake({ stdout: VALUE });
    await resolveSecretRef("DB_PASSWORD", "cmd://staging/db; rm -rf ~", { sources, env: ENV, spawn: f.async }).catch(
      () => undefined,
    );
    // A key with whitespace is not a valid reference: nothing ran.
    expect(f.calls).toHaveLength(0);

    await resolveSecretRef("DB_PASSWORD", "cmd://staging/db", { sources, env: ENV, spawn: f.async });
    expect(f.calls[0]!.argv).toEqual(["/opt/helper", "get"]);
    expect(f.calls[0]!.options.env[SECRET_KEY_ENV]).toBe("staging/db");
    expect(f.calls[0]!.options.env.VAULT_TOKEN).toBe(ENV.VAULT_TOKEN);
    expect(f.calls[0]!.options.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(f.calls[0]!.options.timeoutMs).toBe(1_500);
  });

  it("uses the variable's own name for a bare cmd://", async () => {
    const sources: SecretSources = { ...EMPTY_SECRET_SOURCES, command: ["helper"] };
    const f = fake({ stdout: VALUE });
    await resolveSecretRef("STRIPE_TEST_KEY", "cmd://", { sources, env: ENV, spawn: f.async });
    expect(f.calls[0]!.options.env[SECRET_KEY_ENV]).toBe("STRIPE_TEST_KEY");
  });

  it("fails a cmd:// reference when no command is configured", async () => {
    const f = fake({ stdout: VALUE });
    await expect(
      resolveSecretRef("X_KEY", "cmd://x", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.async }),
    ).rejects.toThrow(/needs "command"/);
    expect(f.calls).toHaveLength(0);
  });

  it("reports a timeout, an oversized output and a missing program by name", () => {
    const run = (outcome: Partial<SecretSpawnOutcome>) => () =>
      resolveSecretRefSync("A_KEY", "op://v/i/f", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: fake(outcome).sync });
    expect(run({ failure: "timeout", exitCode: null })).toThrow("A_KEY: op timed out");
    expect(run({ failure: "too-large", exitCode: null, stdout: "x".repeat(10) })).toThrow(/printed more than 1048576 bytes/);
    expect(run({ failure: "not-found", exitCode: null })).toThrow("A_KEY: op was not found");
    expect(run({ stdout: "" })).toThrow(/printed nothing/);
    expect(run({ stdout: "one\ntwo" })).toThrow(/more than one line/);
  });

  it("never puts stdout in an error, and cuts the value out of the stderr hint", () => {
    const f = fake({ exitCode: 1, stdout: VALUE, stderr: `[ERROR] item ${VALUE} is locked\nmore` });
    let message = "";
    try {
      resolveSecretRefSync("A_KEY", "op://v/i/f", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.sync });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/A_KEY: op failed \(exit code 1\): \[ERROR\] item \[redacted\] is locked/);
    expect(message).not.toContain(VALUE);
    expect(message).not.toContain("more");
  });

  it("caches a value in memory and registers it for masking", async () => {
    const f = fake({ stdout: VALUE });
    const deps = { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.async };
    expect(await resolveSecretRef("A_KEY", "op://v/i/f", deps)).toBe(VALUE);
    expect(await resolveSecretRef("A_KEY", "op://v/i/f", deps)).toBe(VALUE);
    expect(f.calls).toHaveLength(1);
    expect(resolvedSecretValues()).toContainEqual({ label: "A_KEY", value: VALUE });
    expect(resolvedSecretValues().every((v) => v.label === "A_KEY")).toBe(true);
  });

  it("does not cache a failure", async () => {
    const calls: Call[] = [];
    const deps = { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: fake({ failure: "timeout", exitCode: null }, calls).async };
    await expect(resolveSecretRef("A_KEY", "op://v/i/f", deps)).rejects.toThrow(/timed out/);
    await expect(resolveSecretRef("A_KEY", "op://v/i/f", deps)).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(2);
    expect(resolvedSecretValues()).toEqual([]);
  });

  it("refuses a malformed reference without running anything", () => {
    const f = fake({ stdout: VALUE });
    expect(() =>
      resolveSecretRefSync("A_KEY", "op://only-vault", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.sync }),
    ).toThrow(/expected op:\/\/vault\/item\/field/);
    expect(() =>
      resolveSecretRefSync("A_KEY", "bw://--session/password", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.sync }),
    ).toThrow(/expected bw:\/\/item\/field/);
    expect(() =>
      resolveSecretRefSync("A_KEY", "bw://item/uri", { sources: EMPTY_SECRET_SOURCES, env: ENV, spawn: f.sync }),
    ).toThrow(/password, username, totp or notes/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("production runners", () => {
  it.skipIf(process.platform === "win32")("time out a slow command (real spawn)", async () => {
    const sources: SecretSources = {
      ...EMPTY_SECRET_SOURCES,
      command: [process.execPath, "-e", "setTimeout(() => console.log('late1Value2'), 5000)"],
      timeoutMs: 200,
    };
    await expect(resolveSecretRef("SLOW_KEY", "cmd://", { sources, env: { PATH: process.env.PATH } })).rejects.toThrow(
      /timed out/,
    );
  });

  it.skipIf(process.platform === "win32")("pass the key through the environment (real spawn)", async () => {
    const sources: SecretSources = {
      ...EMPTY_SECRET_SOURCES,
      command: [process.execPath, "-e", `process.stdout.write("v-" + process.env.${SECRET_KEY_ENV} + "-9Z")`],
    };
    const value = resolveSecretRefSync("REAL_KEY", "cmd://abc", { sources, env: { PATH: process.env.PATH } });
    expect(value).toBe("v-abc-9Z");
  });

  it.skipIf(process.platform === "win32")("cap the output at 1 MiB (real spawn)", async () => {
    const sources: SecretSources = {
      ...EMPTY_SECRET_SOURCES,
      command: [process.execPath, "-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024))"],
      timeoutMs: 10_000,
    };
    await expect(resolveSecretRef("BIG_KEY", "cmd://", { sources, env: { PATH: process.env.PATH } })).rejects.toThrow(
      /printed more than/,
    );
  });
});
