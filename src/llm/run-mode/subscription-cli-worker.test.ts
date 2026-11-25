import { describe, expect, it } from "vitest";

import {
  describeSubscriptionCliWorker,
  SUBSCRIPTION_CLI_WORKER_POLICY,
} from "./subscription-cli-worker.js";

describe("describeSubscriptionCliWorker", () => {
  it("warns that a Codex worker spends the subscription limit and shows no live progress", () => {
    const notice = describeSubscriptionCliWorker({
      kind: "subscription-cli",
      subscriptionCli: { cli: "codex" },
    });
    expect(notice).not.toBeNull();
    expect(notice?.line).toBe(
      "Workers on a subscription CLI: every task uses your subscription limit, and there is no live progress.",
    );
    expect(notice?.short).toMatch(/no live progress/);
  });

  it("does not claim missing progress for a CLI that streams", () => {
    // Claude Code's adapter streams ndjson; only the limit applies.
    const notice = describeSubscriptionCliWorker({
      kind: "subscription-cli",
      subscriptionCli: { cli: "claude" },
    });
    expect(notice?.line).toMatch(/subscription limit/);
    expect(notice?.line).not.toMatch(/live progress/);
  });

  it("warns, not refuses, until a repro decides otherwise", () => {
    expect(SUBSCRIPTION_CLI_WORKER_POLICY).toBe("warn");
    expect(
      describeSubscriptionCliWorker({
        kind: "subscription-cli",
        subscriptionCli: { cli: "codex" },
      })?.policy,
    ).toBe("warn");
  });

  it("stays silent for a local model or an API-key provider", () => {
    expect(describeSubscriptionCliWorker({ kind: "llama-server" })).toBeNull();
    expect(describeSubscriptionCliWorker({ kind: "openrouter" })).toBeNull();
    expect(
      describeSubscriptionCliWorker({ kind: "openai-compatible", subscriptionCli: null }),
    ).toBeNull();
    expect(describeSubscriptionCliWorker(undefined)).toBeNull();
  });
});
