import { describe, expect, it } from "vitest";

import { resolveTeamsSecret, scrubTeamsError } from "./msteams-types.js";

describe("scrubTeamsError", () => {
  it("removes bearer tokens, JWTs, client secrets and known secret values", () => {
    const msg = scrubTeamsError(
      new Error("Bearer abc.def.ghi failed eyJhbGciOi.eyJzdWIi.sig client_secret=hunter22 pw=my-secret-value"),
      ["my-secret-value"],
    );
    expect(msg).not.toMatch(/abc\.def|eyJhbGciOi|hunter22|my-secret-value/);
  });
});

describe("resolveTeamsSecret", () => {
  it("treats blank as missing and lets an explicit value win", () => {
    expect(resolveTeamsSecret("K", undefined, { K: "  " })).toBeNull();
    expect(resolveTeamsSecret("K", undefined, { K: " v " })).toBe("v");
    expect(resolveTeamsSecret("K", null, { K: "v" })).toBeNull();
  });
});
