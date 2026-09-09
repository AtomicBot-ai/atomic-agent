import { describe, expect, it } from "vitest";

import {
  GITHUB_INTEGRATION_ID,
  GITHUB_TEST_ACTION,
  GITHUB_TOKEN_ENV,
  githubIntegration,
} from "./github-integration.js";
import type { IntegrationStatusContext } from "./integration-descriptor.js";

function ctx(
  present: string[],
  extra: Partial<IntegrationStatusContext> = {},
): IntegrationStatusContext {
  const presentFields = new Set(present);
  return {
    presentFields,
    configured: presentFields.has("token"),
    ...extra,
  };
}

describe("github integration descriptor", () => {
  it("stores the token under the env var gh and the skills hub already read", () => {
    const token = githubIntegration.fields.find((f) => f.key === "token")!;
    expect(GITHUB_TOKEN_ENV).toBe("GITHUB_TOKEN");
    expect(token.envVar).toBe(GITHUB_TOKEN_ENV);
    expect(token.secret).toBe(true);
    expect(token.required).toBe(true);
    expect(token.store).toBeUndefined();
  });

  it("keeps the remote-sync switch in config, not in .env", () => {
    const sync = githubIntegration.fields.find((f) => f.key === "remoteSync")!;
    expect(sync.kind).toBe("boolean");
    expect(sync.store).toBe("config");
    expect(sync.configPath).toBe("git.remoteSync");
    expect(sync.secret).toBe(false);
    expect(sync.required).toBe(false);
  });

  it.each([
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
    "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ])("accepts a GitHub-shaped token %s", (raw) => {
    const token = githubIntegration.fields.find((f) => f.key === "token")!;
    expect(token.validate?.(raw)).toBeUndefined();
  });

  it.each([
    "hunter2",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI",
    "ghp_short",
    "cmp_abcdefghijklmnopqrstuvwxyz",
  ])("rejects %s with a hint about where a token comes from", (raw) => {
    const token = githubIntegration.fields.find((f) => f.key === "token")!;
    expect(token.validate?.(raw)).toMatch(/GitHub token/);
  });

  it("offers the test action only once a token exists, on a key the hub does not own", () => {
    const test = githubIntegration.actions!.find((a) => a.id === GITHUB_TEST_ACTION)!;
    expect(["e", "d", "j", "k", "r"]).not.toContain(test.key);
    expect(test.available?.(ctx([]))).toBe(false);
    expect(test.available?.(ctx(["token"]))).toBe(true);
  });

  it("reports local-only without a token", () => {
    expect(githubIntegration.status(ctx([]))).toEqual({
      level: "not_configured",
      detail: "no token — git stays local",
    });
  });

  it("asks for a test once a token is saved and nothing has been probed", () => {
    expect(githubIntegration.status(ctx(["token"]))).toMatchObject({
      level: "configured",
      detail: expect.stringMatching(/press t/),
    });
  });

  it("badges the probe outcome — connected as the login, or the failure reason", () => {
    const ok = new Map([[GITHUB_INTEGRATION_ID, { ok: true, detail: "octocat" }]]);
    expect(githubIntegration.status(ctx(["token"], { probes: ok }))).toEqual({
      level: "connected",
      detail: "as octocat",
    });
    const bad = new Map([
      [GITHUB_INTEGRATION_ID, { ok: false, detail: "token rejected by GitHub (401)" }],
    ]);
    expect(githubIntegration.status(ctx(["token"], { probes: bad }))).toEqual({
      level: "error",
      detail: "token rejected by GitHub (401)",
    });
  });

  it("carries a walkthrough that tells the operator to scope the token narrowly", () => {
    const steps = githubIntegration.setupSteps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.join("\n")).toMatch(/Fine-grained/);
    expect(steps.join("\n")).toMatch(/Never "All repositories"/);
  });
});
