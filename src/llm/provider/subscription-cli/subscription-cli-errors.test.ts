import { describe, expect, it } from "vitest";

import {
  isEnoent,
  looksLikeAuthFailure,
  mapCliFailure,
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
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
    expect(isEnoent(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
    expect(isEnoent(new Error("x"))).toBe(false);
    expect(isEnoent(null)).toBe(false);
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
