import { describe, expect, it } from "vitest";

import { GITHUB_TOKEN_ENV } from "../github/github-token.js";
import {
  GITHUB_INTEGRATION_ID,
  GITHUB_TOKEN_FIELD,
  githubIntegration,
} from "./github-integration.js";

const VALID = `ghp_${"A".repeat(36)}`;

function ctx(
  present: string[],
  opts: { identity?: string; error?: string } = {},
) {
  return {
    presentFields: new Set(present),
    configured: present.includes(GITHUB_TOKEN_FIELD),
    ...(opts.identity === undefined
      ? {}
      : {
          verifiedIdentities: new Map([[GITHUB_INTEGRATION_ID, opts.identity]]),
        }),
    ...(opts.error === undefined
      ? {}
      : { verifyErrors: new Map([[GITHUB_INTEGRATION_ID, opts.error]]) }),
  };
}

describe("githubIntegration", () => {
  it("stores the token under GITHUB_TOKEN, the name every consumer reads", () => {
    // gh, the skill hub, the updater and the backend installer all
    // already read this variable; a different name would mean two tokens.
    const token = githubIntegration.fields.find(
      (f) => f.key === GITHUB_TOKEN_FIELD,
    );
    expect(token?.envVar).toBe(GITHUB_TOKEN_ENV);
    expect(token?.envVar).toBe("GITHUB_TOKEN");
    expect(token?.secret).toBe(true);
    expect(token?.required).toBe(true);
  });

  it("carries the remote-sync switch as config, not as a secret", () => {
    // The switch is policy, not a credential: it belongs in
    // config.json where an operator can read it back, and it is the
    // one field here that must never be required — a token with the
    // switch off is the default posture, not a half-finished setup.
    const remoteSync = githubIntegration.fields.find(
      (f) => f.key === "remoteSync",
    );
    expect(remoteSync?.store).toBe("config");
    expect(remoteSync?.configPath).toBe("git.remoteSync");
    expect(remoteSync?.kind).toBe("boolean");
    expect(remoteSync?.secret).toBe(false);
    expect(remoteSync?.required).toBe(false);
    expect(remoteSync?.envVar).toBeUndefined();
  });

  it("reads an absent token as not configured", () => {
    expect(githubIntegration.status(ctx([])).level).toBe("not_configured");
  });

  it("separates saved, verified and refused", () => {
    expect(githubIntegration.status(ctx([GITHUB_TOKEN_FIELD]))).toEqual({
      level: "configured",
      detail: "token saved — press v to verify",
    });
    expect(
      githubIntegration.status(
        ctx([GITHUB_TOKEN_FIELD], { identity: "@octo · repo" }),
      ),
    ).toEqual({ level: "connected", detail: "@octo · repo" });
    expect(
      githubIntegration.status(ctx([GITHUB_TOKEN_FIELD], { error: "HTTP 401" }))
        .level,
    ).toBe("error");
  });

  it("an error outranks a stale identity", () => {
    expect(
      githubIntegration.status(
        ctx([GITHUB_TOKEN_FIELD], { identity: "@octo", error: "HTTP 401" }),
      ).level,
    ).toBe("error");
  });

  it("rejects a paste that is not a token", () => {
    const validate = githubIntegration.fields[0]?.validate;
    expect(validate?.(VALID)).toBeUndefined();
    expect(validate?.("my-token-name")).toMatch(
      /Doesn't look like a GitHub token/,
    );
  });

  it("offers verify only once a token exists, and import always", () => {
    const actions = githubIntegration.actions ?? [];
    const verify = actions.find((a) => a.id === "verify");
    const importAction = actions.find((a) => a.id === "import");
    expect(verify?.available?.(ctx([]))).toBe(false);
    expect(verify?.available?.(ctx([GITHUB_TOKEN_FIELD]))).toBe(true);
    expect(importAction?.available).toBeUndefined();
  });

  it("does not let an action key shadow edit, clear or navigation", () => {
    for (const action of githubIntegration.actions ?? []) {
      expect(["e", "d", "j", "k"]).not.toContain(action.key);
    }
  });
});
