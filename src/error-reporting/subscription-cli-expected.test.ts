import { describe, expect, it, vi } from "vitest";

import { TransportError } from "../llm/reliability/llm-failures.js";
import {
  mapCliFailure,
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
} from "../llm/provider/subscription-cli/subscription-cli-errors.js";
import { captureError } from "./error-reporter.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import type { SentryClient } from "./sentry-client.js";
import { isExpectedSubscriptionCliFailure } from "./subscription-cli-expected.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

const failure = (stderr: string) =>
  mapCliFailure({
    binary: "codex",
    installHint: "Install Codex.",
    authHint: "Run `codex login`.",
    exitCode: 1,
    stdout: "",
    stderr,
    timedOut: false,
    truncated: false,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });

const wrap = (err: Error) => new TransportError(err.message, null, "", { cause: err });

describe("isExpectedSubscriptionCliFailure (ATO-2417)", () => {
  it("is a signed-out CLI, a spent limit and a plan without the CLI, also wrapped", () => {
    const signedOut = new SubscriptionCliAuthError("claude", "Run `claude` and complete /login.");
    const limit = new SubscriptionCliInvocationError("codex turn failed: You've hit your usage limit.", 1, "turn_failed");
    const plan = new SubscriptionCliInvocationError(
      "codex turn failed: To use Codex with your ChatGPT plan, upgrade to Plus.",
      1,
      "turn_failed",
    );
    for (const err of [signedOut, limit, plan]) {
      expect(isExpectedSubscriptionCliFailure(err)).toBe(true);
      expect(isExpectedSubscriptionCliFailure(wrap(err))).toBe(true);
    }
    expect(
      isExpectedSubscriptionCliFailure(
        failure("Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."),
      ),
    ).toBe(true);
  });

  it("is not any other CLI failure", () => {
    expect(isExpectedSubscriptionCliFailure(failure("error: unknown option '--ignore-user-config'"))).toBe(false);
    expect(isExpectedSubscriptionCliFailure(failure(""))).toBe(false);
    expect(isExpectedSubscriptionCliFailure(new SubscriptionCliInvocationError('"claude" timed out', null, "timeout"))).toBe(false);
    expect(isExpectedSubscriptionCliFailure(new Error("You've hit your usage limit."))).toBe(false);
    // Exit 127 still reports: part of it was our own PATH (ATO-1679).
    expect(
      isExpectedSubscriptionCliFailure(
        new SubscriptionCliInvocationError('"claude" exited with code 127: env: node: No such file or directory', 127),
      ),
    ).toBe(false);
    expect(isExpectedSubscriptionCliFailure("not an error")).toBe(false);
  });
});

describe("a subscription CLI that is not installed (ATO-1679)", () => {
  it("is the person's setup, bare and wrapped as the step hands it over (CLI-HP)", () => {
    const missing = new SubscriptionCliNotInstalledError("claude", "Install it in PowerShell.", "Claude Code");
    expect(isExpectedSubscriptionCliFailure(missing)).toBe(true);
    expect(isExpectedSubscriptionCliFailure(wrap(missing))).toBe(true);
  });

  it("is not reported", () => {
    const { client, captured } = fakeClient();
    captureError(client, wrap(new SubscriptionCliNotInstalledError("claude.cmd", "Install it in PowerShell.")), {
      source: "llm_failure",
      category: "transport",
    });
    expect(captured).toHaveLength(0);
  });
});

describe("captureError and a subscription CLI's account state (ATO-2417)", () => {
  it("does not report a signed-out CLI or a spent limit", () => {
    const { client, captured } = fakeClient();
    captureError(client, wrap(new SubscriptionCliAuthError("claude", "Run `claude` and complete /login.")), {
      source: "llm_failure",
      category: "transport",
    });
    captureError(client, new SubscriptionCliInvocationError("claude reported error: Claude AI usage limit reached", null, "reported_error"), {
      source: "llm_failure",
      category: "tool",
    });
    expect(captured).toHaveLength(0);
  });

  it("still reports an exit it cannot explain", () => {
    const { client, captured } = fakeClient();
    captureError(client, failure("Segmentation fault"), { source: "llm_failure", category: "tool" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.errorType).toBe("SubscriptionCliInvocationError");
  });
});
