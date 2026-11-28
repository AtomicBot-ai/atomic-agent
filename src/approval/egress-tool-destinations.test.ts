import { describe, expect, it } from "vitest";
import { gitPushEgress, httpRequestEgress } from "./egress-tool-destinations.js";

describe("egress of os.git.push and os.http.request (ATO-2528)", () => {
  it.each([
    ["https://github.com/org/repo.git", "github.com"],
    ["git@github.com:org/repo.git", "github.com"],
    ["ssh://git@gitlab.example.com:2222/x.git", "gitlab.example.com"],
  ])("a push to %s goes to %s", (url, host) => {
    expect(gitPushEgress(url, "origin")).toEqual([{ kind: "git_remote", host, direction: "outbound", label: host }]);
  });

  it("a push to a path on this machine sends nothing out", () => {
    expect(gitPushEgress("/srv/repo.git", "backup")).toEqual([]);
    expect(gitPushEgress("file:///srv/repo.git", "backup")).toEqual([]);
  });

  it("an unreadable remote is an unknown host, named by its remote", () => {
    expect(gitPushEgress("", "origin")).toEqual([
      { kind: "git_remote", host: null, direction: "outbound", label: 'git remote "origin"' },
    ]);
  });

  // Review round 1 (F2105.1): `git push origin` sends to every pushurl.
  it("a remote with several push URLs goes to each of their hosts", () => {
    expect(
      gitPushEgress(
        ["https://github.com/me/r.git", "https://evil.example/x.git", "git@github.com:me/r.git", "/srv/r.git"],
        "origin",
      ).map((entry) => entry.host),
    ).toEqual(["github.com", "evil.example"]);
    expect(gitPushEgress(["https://github.com/me/r.git", ""], "origin").map((entry) => entry.host)).toEqual([
      "github.com",
      null,
    ]);
    expect(gitPushEgress([], "origin")).toEqual([
      { kind: "git_remote", host: null, direction: "outbound", label: 'git remote "origin"' },
    ]);
  });

  it("a POST sends, a GET only fetches", () => {
    const url = new URL("https://API.example.com/x");
    expect(httpRequestEgress(url, "post")[0]).toMatchObject({ host: "api.example.com", direction: "outbound" });
    expect(httpRequestEgress(url, "GET")[0]).toMatchObject({ direction: "inbound" });
  });
});
