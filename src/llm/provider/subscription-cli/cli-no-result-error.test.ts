import { describe, expect, it } from "vitest";

import { noResultEnvelopeError } from "./cli-no-result-error.js";
import { SubscriptionCliInvocationError } from "./subscription-cli-errors.js";

describe("noResultEnvelopeError (ATO-2522)", () => {
  it("is a typed CLI failure with a fixed kind and exit code 0", () => {
    const err = noResultEnvelopeError("claude", "Claude Code");
    expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
    expect(err.name).toBe("SubscriptionCliInvocationError");
    expect(err.failureKind).toBe("no_result_envelope");
    expect(err.exitCode).toBe(0);
  });

  it("says what happened and what to try, in plain words", () => {
    const message = noResultEnvelopeError("C:\\Users\\n\\.local\\bin\\claude.exe", "Claude Code").message;
    expect(message).toMatch(/^Claude Code finished without sending its answer/);
    expect(message).toContain("Send the message again");
    expect(message).toContain("`claude update`");
    expect(message).not.toContain("envelope");
    expect(message).not.toContain("C:\\");
  });

  it("names the Codex update for Codex, and stays generic for another binary", () => {
    expect(noResultEnvelopeError("codex", "Codex").message).toContain("@openai/codex@latest");
    expect(noResultEnvelopeError("/opt/x/my-cli", "My CLI").message).toContain("update it the way you installed it");
  });

  it("keeps its kind even when the words look like a limit", () => {
    // The kind is ours, not read from the CLI's text.
    expect(new SubscriptionCliInvocationError("usage limit reached", 0, "no_result_envelope").failureKind).toBe(
      "no_result_envelope",
    );
  });
});
