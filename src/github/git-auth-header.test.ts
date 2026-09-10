import { describe, expect, it } from "vitest";

import {
  GITHUB_EXTRAHEADER_KEY,
  githubAuthGitEnv,
  githubAuthHeaderValue,
} from "./git-auth-header.js";

describe("githubAuthGitEnv", () => {
  it("injects a github.com-scoped basic x-access-token header through the env", () => {
    const env = githubAuthGitEnv("ghp_secret");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    // The URL-scoped key is what keeps the header off every other remote.
    expect(env.GIT_CONFIG_KEY_0).toBe(GITHUB_EXTRAHEADER_KEY);
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    const decoded = Buffer.from(
      env.GIT_CONFIG_VALUE_0!.replace("AUTHORIZATION: basic ", ""),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe("x-access-token:ghp_secret");
  });

  it("encodes the header GitHub documents", () => {
    expect(githubAuthHeaderValue("t")).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:t").toString("base64")}`,
    );
  });
});
