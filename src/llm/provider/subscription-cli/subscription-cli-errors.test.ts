import { describe, expect, it } from "vitest";

import { TransportError } from "../../reliability/llm-failures.js";
import { claudeCliAdapter } from "./claude-cli-adapter.js";
import {
  isEnoent,
  isSubscriptionCliSetupError,
  isSpawnEinval,
  looksLikeAuthFailure,
  mapCliFailure,
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
  SubscriptionCliSpawnError,
} from "./subscription-cli-errors.js";

const base = {
  binary: "claude",
  installHint: "Install Claude Code.",
  authHint: "Run `claude` and complete /login.",
  exitCode: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  timeoutMs: 1000,
  maxOutputBytes: 4096,
};

describe("isEnoent", () => {
  it("detects the spawn error for a missing binary", () => {
    expect(isEnoent(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      true,
    );
    expect(isEnoent(new Error("x"))).toBe(false);
    expect(isEnoent(null)).toBe(false);
  });
});

describe("isSpawnEinval", () => {
  it("detects the thrown spawn error for a batch shim", () => {
    const err = Object.assign(new Error("spawn EINVAL"), {
      code: "EINVAL",
      errno: -22,
      syscall: "spawn",
    });
    expect(isSpawnEinval(err)).toBe(true);
    expect(
      isSpawnEinval(Object.assign(new Error("x"), { code: "EINVAL" })),
    ).toBe(true);
  });

  it("ignores anything else", () => {
    expect(
      isSpawnEinval(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toBe(false);
    expect(
      isSpawnEinval(
        Object.assign(new Error("x"), { code: "EINVAL", syscall: "read" }),
      ),
    ).toBe(false);
    expect(isSpawnEinval(new Error("x"))).toBe(false);
    expect(isSpawnEinval(null)).toBe(false);
  });
});

describe("SubscriptionCliSpawnError", () => {
  it("keeps the install hint and stays apart from not-installed", () => {
    const err = new SubscriptionCliSpawnError("claude", "Install Claude Code.");
    expect(err.message).toContain("Install Claude Code.");
    expect(err.message).toContain("EINVAL");
    expect(err).not.toBeInstanceOf(SubscriptionCliNotInstalledError);
  });
});

describe("looksLikeAuthFailure", () => {
  it("matches the signed-out phrasings", () => {
    for (const text of [
      "Please run /login to authenticate",
      "You are not logged in",
      "Authentication required",
      "Invalid API key",
      "401 Unauthorized",
      "credentials expired",
    ]) {
      expect(looksLikeAuthFailure(text)).toBe(true);
    }
  });

  it("does not claim an auth problem for ordinary failures", () => {
    // A false positive would send the user to /login for a rate limit.
    for (const text of [
      "5-hour limit reached; resets at 14:00",
      "network error: ECONNRESET",
      "model not found",
      "Overloaded",
    ]) {
      expect(looksLikeAuthFailure(text)).toBe(false);
    }
  });
});

describe("mapCliFailure", () => {
  it("reports a timeout with the budget that was exceeded", () => {
    const err = mapCliFailure({ ...base, timedOut: true });
    expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
    expect(err.message).toMatch(/timed out after 1000ms/);
  });

  it("refuses to parse truncated output rather than failing later", () => {
    const err = mapCliFailure({ ...base, truncated: true });
    expect(err.message).toMatch(/refusing to parse a truncated response/);
  });

  it("maps a signed-out CLI to an auth error carrying the hint", () => {
    const err = mapCliFailure({
      ...base,
      stderr: "Error: not logged in. Please run /login",
    });
    expect(err).toBeInstanceOf(SubscriptionCliAuthError);
    expect(err.message).toMatch(/complete \/login/);
  });

  it("passes an unexplained failure through verbatim", () => {
    // Subscription rate limits have no structured form; swallowing the
    // text would leave the user with an exit code and nothing else.
    const err = mapCliFailure({
      ...base,
      exitCode: 2,
      stderr: "weekly limit reached, resets Monday",
    });
    expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
    expect(err.message).toMatch(/exited with code 2/);
    expect(err.message).toMatch(/weekly limit reached, resets Monday/);
  });

  it("truncates a huge stderr instead of pasting megabytes into the message", () => {
    const err = mapCliFailure({ ...base, stderr: "e".repeat(10_000) });
    expect(err.message.length).toBeLessThan(3000);
  });
});

describe("error messages", () => {
  it("tells the user how to fix a missing binary", () => {
    const err = new SubscriptionCliNotInstalledError("claude", "Install it.");
    expect(err.message).toMatch(/"claude" was not found on PATH/);
    expect(err.message).toMatch(/Install it\./);
  });
});

describe("the not-installed message for a named CLI", () => {
  it("says which tool is missing in the words of someone who picked it", () => {
    // ATO-117: the desktop user had picked "Claude Code subscription".
    const err = new SubscriptionCliNotInstalledError(
      "claude",
      claudeCliAdapter.installHint,
      claudeCliAdapter.productName,
    );
    expect(err.message).toMatch(
      /^Claude Code isn't installed \(the `claude` command was not found\)\. Install Claude Code and sign in, or choose another provider\./,
    );
  });
});

describe("isSubscriptionCliSetupError", () => {
  it("finds a missing or signed-out CLI however it was wrapped", () => {
    const missing = new SubscriptionCliNotInstalledError("claude", "x");
    expect(isSubscriptionCliSetupError(missing)).toBe(true);
    expect(
      isSubscriptionCliSetupError(new SubscriptionCliAuthError("claude", "x")),
    ).toBe(true);
    // The step executor's wrapping: a status-less TransportError.
    expect(
      isSubscriptionCliSetupError(
        new TransportError(missing.message, null, "", { cause: missing }),
      ),
    ).toBe(true);
  });

  it("is nothing else", () => {
    expect(
      isSubscriptionCliSetupError(new SubscriptionCliInvocationError("boom", 1)),
    ).toBe(false);
    expect(isSubscriptionCliSetupError(new TypeError("fetch failed"))).toBe(
      false,
    );
    expect(isSubscriptionCliSetupError(null)).toBe(false);
  });
});
