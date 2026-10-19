import { describe, expect, it } from "vitest";

import { TransportError } from "../../reliability/llm-failures.js";
import { claudeCliAdapter } from "./claude-cli-adapter.js";
import {
  cliReportedError,
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
      // Claude Code's expired-login envelope (ATO-755).
      "authentication_failed",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "OAuth token has expired",
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
      "OAuth is not configured for this MCP server",
      "session expired, starting a new one",
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

  it("reads an expired login out of Claude Code's result envelope", () => {
    // ATO-755: stderr is empty and the only explanation is this line.
    const err = mapCliFailure({
      ...base,
      stdout: [
        '{"type":"system","subtype":"init"}',
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          error: "authentication_failed",
          result:
            "Failed to authenticate: OAuth session expired and could not be refreshed",
        }),
      ].join("\n"),
    });
    expect(err).toBeInstanceOf(SubscriptionCliAuthError);
    expect(err.message).toBe(
      '"claude" is not signed in. Run `claude` and complete /login. (Failed to authenticate: OAuth session expired and could not be refreshed (authentication_failed))',
    );
  });

  it("passes a non-auth envelope failure through as text, not JSON", () => {
    const err = mapCliFailure({
      ...base,
      stdout: '{"type":"result","is_error":true,"result":"5-hour limit reached; resets at 14:00"}',
    });
    expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
    expect(err.message).toBe(
      '"claude" exited with code 1: 5-hour limit reached; resets at 14:00',
    );
  });

  it("does not read the model's own words in the stream as an auth problem", () => {
    // A delta that mentions "unauthorized" is not the CLI failing auth
    // once the envelope says what actually went wrong.
    const err = mapCliFailure({
      ...base,
      stdout: [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"401 Unauthorized"}}}',
        '{"type":"result","subtype":"error_max_turns","is_error":true}',
      ].join("\n"),
    });
    expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
    expect(err.message).toMatch(/exited with code 1: error_max_turns$/);
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

describe("cliReportedError", () => {
  it("finds Codex's failure events and drops the duplicate", () => {
    expect(
      cliReportedError(
        [
          '{"type":"thread.started"}',
          '{"type":"error","message":"Your access token could not be refreshed"}',
          '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed"}}',
        ].join("\n"),
      ),
    ).toBe("Your access token could not be refreshed");
  });

  it("is null when nothing in the output reports a failure", () => {
    expect(cliReportedError("")).toBeNull();
    expect(cliReportedError("plain text\nnot json {")).toBeNull();
    expect(
      cliReportedError('{"type":"result","subtype":"success","result":"ok"}'),
    ).toBeNull();
  });
});
