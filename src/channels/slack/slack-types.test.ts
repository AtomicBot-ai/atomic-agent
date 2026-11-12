import { describe, expect, it } from "vitest";

import { describeSlackError, resolveSlackToken, scrubSlackError } from "./slack-types.js";

describe("scrubSlackError", () => {
  it("replaces bot, user and app tokens", () => {
    const msg = scrubSlackError(
      new Error("failed with xoxb-1234-5678-abcdEFGH and xapp-1-A0-123-abc and xoxp-9-9"),
    );
    expect(msg).not.toMatch(/xox[bp]-\d/);
    expect(msg).not.toContain("xapp-1");
    expect(msg.match(/<token>/g)).toHaveLength(3);
  });

  it("redacts the Socket Mode ticket in a wss URL", () => {
    const msg = scrubSlackError("connect wss://wss-primary.slack.com/link/?ticket=abc-123&app_id=A1 failed");
    expect(msg).toContain("ticket=<redacted>");
    expect(msg).not.toContain("abc-123");
    expect(msg).toContain("app_id=A1");
  });
});

describe("resolveSlackToken", () => {
  it("prefers the explicit value, including null", () => {
    expect(resolveSlackToken("K", "x", { K: "y" })).toBe("x");
    expect(resolveSlackToken("K", null, { K: "y" })).toBeNull();
  });

  it("treats a blank env value as not configured", () => {
    expect(resolveSlackToken("K", undefined, { K: "   " })).toBeNull();
    expect(resolveSlackToken("K", undefined, {})).toBeNull();
    expect(resolveSlackToken("K", undefined, { K: " xoxb-1 " })).toBe("xoxb-1");
  });
});

describe("describeSlackError", () => {
  it("names the token problem the operator can fix", () => {
    expect(describeSlackError("invalid_auth")).toMatch(/rejected the token/);
    expect(describeSlackError("not_allowed_token_type")).toMatch(/xoxb-.*xapp-/);
    expect(describeSlackError("something_new")).toBe("Slack returned something_new.");
  });
});
