import { afterEach, describe, expect, it } from "vitest";

import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { resetSecretRefCache, type SecretSpawnOutcome } from "../config/secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES } from "../config/secret-refs.js";
import type { DoctorContext } from "./doctor-checks.js";
import { createSecretRefsCheck } from "./doctor-secret-refs.js";

// ATO-2530: atag doctor resolves each saved reference and reports by name.
// op and bw are faked; nothing real runs.
const VALUE = "Doctor9Secret8Value7";
const ctx = { stateDir: "/state" } as DoctorContext;

afterEach(() => {
  resetSecretRefCache();
  resetResolvedSecretValues();
});

describe("doctor secret-refs check", () => {
  it("reports ok for a reference that resolves and fail with the reason for one that does not, never a value", () => {
    const check = createSecretRefsCheck({
      list: () => [
        { name: "OPENROUTER_API_KEY", ref: "op://Private/OR/credential", source: "1password", store: "env" },
        { name: "NPM_TOKEN", ref: "bw://npm/password", source: "bitwarden", store: "keychain" },
      ],
      sources: () => EMPTY_SECRET_SOURCES,
      env: { PATH: "/usr/bin" },
      spawn: (argv): SecretSpawnOutcome =>
        argv.includes("op")
          ? { stdout: VALUE, stderr: "", exitCode: 0, failure: null }
          : { stdout: "", stderr: "You are not logged in.", exitCode: 1, failure: null },
    });
    const findings = check(ctx);
    expect(findings).toEqual([
      { check: "secret-refs", status: "ok", message: "OPENROUTER_API_KEY: read from 1Password" },
      {
        check: "secret-refs",
        status: "fail",
        message: expect.stringMatching(/^NPM_TOKEN: bw failed .*not logged in.*Bitwarden; sign in there/),
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(VALUE);
  });

  it("fails on a broken secret-sources.json and lists tool secret names", () => {
    const check = createSecretRefsCheck({
      list: () => [],
      sources: (_dir, warn) => {
        warn("secret-sources.json is not valid JSON");
        return { ...EMPTY_SECRET_SOURCES, toolSecrets: { GITHUB_TOKEN: "op://a/b/c" } };
      },
    });
    const findings = check(ctx);
    expect(findings[0]).toMatchObject({ status: "fail", message: expect.stringContaining("not valid JSON") });
    expect(findings[1]).toMatchObject({ status: "ok", message: expect.stringContaining("GITHUB_TOKEN") });
  });

  it("says nothing when no key is a reference", () => {
    expect(createSecretRefsCheck({ list: () => [], sources: () => EMPTY_SECRET_SOURCES })(ctx)).toEqual([]);
  });
});
