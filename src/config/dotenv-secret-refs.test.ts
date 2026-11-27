import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maskSecrets } from "../error-reporting/secret-detector.js";
import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { resolveDotenvSecretRefs } from "./dotenv-secret-refs.js";
import { readSavedSecret } from "./secret-access.js";
import { resetSecretRefCache, type SecretSpawnOutcome } from "./secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES } from "./secret-refs.js";

const VALUE = "Resolved7Key8Value9";

describe("resolveDotenvSecretRefs (ATO-2339)", () => {
  let dir: string;
  let warnings: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-dotenv-refs-"));
    warnings = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetSecretRefCache();
    resetResolvedSecretValues();
  });

  const ok = (): SecretSpawnOutcome => ({ stdout: `${VALUE}\n`, stderr: "", exitCode: 0, failure: null });

  it("puts the value in the environment only; the file and the saved-secret read keep the reference", () => {
    const ref = "op://Private/OpenRouter/credential";
    writeFileSync(join(dir, ".env"), `OPENROUTER_API_KEY=${ref}\n`);
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: ref, PATH: "/usr/bin" };
    const result = resolveDotenvSecretRefs(dir, ["OPENROUTER_API_KEY"], {
      env,
      sources: EMPTY_SECRET_SOURCES,
      spawn: ok,
      warn: (m) => warnings.push(m),
    });
    expect(result).toEqual({ resolved: ["OPENROUTER_API_KEY"], failed: [] });
    expect(env.OPENROUTER_API_KEY).toBe(VALUE);
    // Never written back; `config secrets get` / `GET /api/secrets` show the ref.
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`OPENROUTER_API_KEY=${ref}\n`);
    expect(readSavedSecret(dir, "OPENROUTER_API_KEY")).toEqual({ ok: true, value: ref, store: "env" });
    // And masked in any later output, whatever list the caller passes.
    expect(maskSecrets(`key is ${VALUE}`)).toBe("key is [redacted:OPENROUTER_API_KEY]");
  });

  it("unsets a reference that fails and says so by name, never as a literal key", () => {
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: "op://Private/Groq/credential" };
    const result = resolveDotenvSecretRefs(dir, ["GROQ_API_KEY"], {
      env,
      sources: EMPTY_SECRET_SOURCES,
      spawn: () => ({ stdout: "", stderr: "not signed in", exitCode: 1, failure: null }),
      warn: (m) => warnings.push(m),
    });
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(result?.failed[0]?.name).toBe("GROQ_API_KEY");
    expect(warnings[0]).toMatch(/GROQ_API_KEY .*not set this run/);
  });

  it("touches only the names the loader applied and returns null without a reference", () => {
    const env: NodeJS.ProcessEnv = { A_KEY: "plain-value-1234", SHELL_KEY: "op://x/y/z" };
    let ran = 0;
    const spawn = () => {
      ran++;
      return ok();
    };
    expect(resolveDotenvSecretRefs(dir, ["A_KEY"], { env, sources: EMPTY_SECRET_SOURCES, spawn })).toBeNull();
    expect(env.SHELL_KEY).toBe("op://x/y/z");
    expect(ran).toBe(0);
  });
});
