import { describe, expect, it } from "vitest";

import { githubAuthGitArgs } from "./git-auth-header.js";

describe("githubAuthGitArgs", () => {
  it("scopes a basic x-access-token header to github.com only", () => {
    const args = githubAuthGitArgs("ghp_secret");
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-c");
    const [key, value] = args[1]!.split("=", 2);
    // The URL-scoped key is what keeps the header off every other remote.
    expect(key).toBe("http.https://github.com/.extraheader");
    expect(value).toMatch(/^AUTHORIZATION: basic /);
    const decoded = Buffer.from(
      value!.replace("AUTHORIZATION: basic ", ""),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe("x-access-token:ghp_secret");
  });

  it("never leaves the raw token in the argv", () => {
    const args = githubAuthGitArgs("ghp_secret");
    expect(args.join(" ")).not.toContain("ghp_secret");
  });
});
