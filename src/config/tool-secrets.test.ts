import { afterEach, describe, expect, it } from "vitest";

import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { resetSecretRefCache, type SecretSpawnOutcome } from "./secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES, type SecretSources } from "./secret-refs.js";
import { createToolSecretSource } from "./tool-secrets.js";

afterEach(() => {
  resetSecretRefCache();
  resetResolvedSecretValues();
});

const SOURCES: SecretSources = {
  ...EMPTY_SECRET_SOURCES,
  toolSecrets: { DEPLOY_TOKEN: "op://Private/Deploy/credential", WEAK_TOKEN: "op://Private/Weak/credential" },
};

function spawnPrinting(byRef: Record<string, string>) {
  const argvs: (readonly string[])[] = [];
  return {
    argvs,
    spawn: async (argv: readonly string[]): Promise<SecretSpawnOutcome> => {
      argvs.push(argv);
      return { stdout: byRef[argv[2]!] ?? "", stderr: "", exitCode: 0, failure: null };
    },
  };
}

describe("createToolSecretSource (ATO-476)", () => {
  it("offers only the listed names", () => {
    const source = createToolSecretSource("/unused", { sources: () => SOURCES });
    expect(source.has("DEPLOY_TOKEN")).toBe(true);
    expect(source.has("OPENROUTER_API_KEY")).toBe(false);
    expect(source.has("toString")).toBe(false);
  });

  it("resolves a listed name through its reference", async () => {
    const f = spawnPrinting({ "op://Private/Deploy/credential": "Deploy1Token2Value3\n" });
    const source = createToolSecretSource("/unused", { sources: () => SOURCES, spawn: f.spawn, env: {} });
    expect(await source.resolve("DEPLOY_TOKEN")).toBe("Deploy1Token2Value3");
    expect(f.argvs).toEqual([["op", "read", "op://Private/Deploy/credential"]]);
  });

  it("refuses an unlisted name and a value too plain to be masked", async () => {
    const f = spawnPrinting({ "op://Private/Weak/credential": "hunter" });
    const source = createToolSecretSource("/unused", { sources: () => SOURCES, spawn: f.spawn, env: {} });
    await expect(source.resolve("OPENROUTER_API_KEY")).rejects.toThrow("no tool secret named OPENROUTER_API_KEY");
    const err = await source.resolve("WEAK_TOKEN").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/WEAK_TOKEN: the value is too short or too plain/);
    expect((err as Error).message).not.toContain("hunter");
  });

  it("is empty when nothing is configured", () => {
    const source = createToolSecretSource("/unused", { sources: () => EMPTY_SECRET_SOURCES });
    expect(source.has("DEPLOY_TOKEN")).toBe(false);
  });
});
