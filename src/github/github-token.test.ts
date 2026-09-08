import { describe, expect, it } from "vitest";

import {
  GITHUB_TOKEN_ENV,
  looksLikeGithubToken,
  resolveGithubToken,
  scrubGithubToken,
} from "./github-token.js";

const CLASSIC = `ghp_${"A".repeat(36)}`;
const FINE_GRAINED = `github_pat_${"B".repeat(22)}_${"c".repeat(59)}`;
const GH_OAUTH = `gho_${"D".repeat(36)}`;

describe("looksLikeGithubToken", () => {
  it("accepts classic, fine-grained and gh-minted tokens", () => {
    expect(looksLikeGithubToken(CLASSIC)).toBe(true);
    expect(looksLikeGithubToken(FINE_GRAINED)).toBe(true);
    expect(looksLikeGithubToken(GH_OAUTH)).toBe(true);
    expect(looksLikeGithubToken(`  ${CLASSIC}  `)).toBe(true);
  });

  it("rejects the things people paste by mistake", () => {
    // The token's name, a client secret, an SSH key, an empty field.
    expect(looksLikeGithubToken("atomic-agent")).toBe(false);
    expect(looksLikeGithubToken("Xy9_ThisLooksLikeAClientSecret123456")).toBe(false);
    expect(looksLikeGithubToken("ssh-ed25519 AAAAC3Nza")).toBe(false);
    expect(looksLikeGithubToken("")).toBe(false);
    expect(looksLikeGithubToken("ghp_short")).toBe(false);
  });
});

describe("resolveGithubToken", () => {
  it("reads GITHUB_TOKEN and treats blank as absent", () => {
    expect(resolveGithubToken(undefined, { [GITHUB_TOKEN_ENV]: CLASSIC })).toBe(CLASSIC);
    expect(resolveGithubToken(undefined, { [GITHUB_TOKEN_ENV]: "   " })).toBeNull();
    expect(resolveGithubToken(undefined, {})).toBeNull();
  });

  it("lets an explicit value win, including an explicit null", () => {
    expect(resolveGithubToken("x", { [GITHUB_TOKEN_ENV]: CLASSIC })).toBe("x");
    expect(resolveGithubToken(null, { [GITHUB_TOKEN_ENV]: CLASSIC })).toBeNull();
  });
});

describe("scrubGithubToken", () => {
  it("masks every token shape and the basic-auth header git echoes", () => {
    const basic = Buffer.from(`x-access-token:${CLASSIC}`).toString("base64");
    const msg = `fatal: ${CLASSIC} and ${FINE_GRAINED} via AUTHORIZATION: basic ${basic}`;
    const out = scrubGithubToken(msg);
    expect(out).not.toContain(CLASSIC);
    expect(out).not.toContain(FINE_GRAINED);
    expect(out).not.toContain(basic);
    expect(out).toContain("<token>");
    expect(out).toContain("AUTHORIZATION: basic <redacted>");
  });

  it("leaves ordinary text alone", () => {
    expect(scrubGithubToken("remote: Permission denied")).toBe(
      "remote: Permission denied",
    );
  });
});
