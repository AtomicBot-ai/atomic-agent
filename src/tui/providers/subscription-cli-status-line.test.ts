import { describe, expect, it } from "vitest";

import type { SubscriptionCliStatusReport } from "../../llm/provider/subscription-cli/index.js";
import { subscriptionCliStatusLine } from "./subscription-cli-status-line.js";

const base: SubscriptionCliStatusReport = {
  cli: "codex", productName: "Codex", state: "ready", installed: true, version: "0.46.0",
  signedIn: true, loginCheck: "command", fix: null, message: "", billingEnvSet: [],
};

describe("subscriptionCliStatusLine (ATO-1204)", () => {
  it("checking while the answer is out", () => {
    expect(subscriptionCliStatusLine(null, "codex")).toEqual({ text: "Checking the codex CLI…", tone: "muted" });
  });
  it("ready", () => {
    expect(subscriptionCliStatusLine(base, "codex")).toEqual({ text: "✓ ready: Codex 0.46.0, signed in", tone: "ok" });
  });
  it("not installed shows the install command", () => {
    const r = subscriptionCliStatusLine({ ...base, cli: "claude", productName: "Claude Code", state: "missing", installed: false, version: null, fix: "curl -fsSL https://claude.ai/install.sh | bash" }, "claude");
    expect(r).toEqual({ text: "Claude Code is not installed. Install it: curl -fsSL https://claude.ai/install.sh | bash", tone: "warn" });
  });
  it("signed out shows the login command, and an API-key login says it bills per token", () => {
    expect(subscriptionCliStatusLine({ ...base, state: "signed_out", signedIn: false, fix: "codex login" }, "codex").text)
      .toBe("Codex is not signed in. Run: codex login");
    expect(subscriptionCliStatusLine({ ...base, state: "signed_out", signedIn: false, apiKeyLogin: true, fix: "codex login" }, "codex").text)
      .toMatch(/bills per token/);
  });
  it("unknown says it can't verify, never that it is ready", () => {
    const r = subscriptionCliStatusLine({ ...base, cli: "claude", productName: "Claude Code", state: "unknown", signedIn: null }, "claude");
    expect(r.text).toMatch(/can't verify the login/);
    expect(r.text).not.toMatch(/ready/);
  });
});
