import { describe, expect, it } from "vitest";

import {
  SubscriptionCliAuthError,
  SubscriptionCliCommandLineError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
  mapCliFailure,
} from "../llm/provider/subscription-cli/subscription-cli-errors.js";
import { scrubError } from "./error-scrubber.js";
import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope, buildFingerprint } from "./sentry-envelope.js";
import { extractSubscriptionCliFailureTags } from "./subscription-cli-failure-tag.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "1.2.3", platform: "darwin" };

/** stderr with a path and a secret-looking line: none of it may travel. */
const STDERR = "Error: cannot open /Users/someone/project/notes.md\nsk-ant-api03-SECRETSECRETSECRET";

function failure(overrides: Partial<Parameters<typeof mapCliFailure>[0]> = {}): Error {
  return mapCliFailure({
    binary: "/opt/tools/claude",
    installHint: "",
    authHint: "",
    exitCode: 1,
    stdout: "",
    stderr: STDERR,
    timedOut: false,
    truncated: false,
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    ...overrides,
  });
}

function tagsOf(err: Error): Record<string, string> {
  const ev = scrubError(err, { source: "llm_failure", category: "transport" });
  const body = buildEnvelope(DSN, ev, META).body;
  return (JSON.parse(body.trim().split("\n")[2]!) as { tags: Record<string, string> }).tags;
}

describe("cli_failure / cli_exit_code tags (ATO-1446)", () => {
  it("says why a CLI run failed, with its exit code", () => {
    expect(extractSubscriptionCliFailureTags(failure())).toEqual({ cli_failure: "exited", cli_exit_code: "1" });
    expect(extractSubscriptionCliFailureTags(failure({ timedOut: true, exitCode: null }))).toEqual({ cli_failure: "timeout" });
    expect(extractSubscriptionCliFailureTags(failure({ truncated: true }))?.cli_failure).toBe("output_too_large");
    expect(extractSubscriptionCliFailureTags(failure({ inputTruncated: true }))?.cli_failure).toBe("input_truncated");
  });

  it("names a usage limit as limit_reached", () => {
    const err = failure({ stderr: "Claude AI usage limit reached|1762000000", exitCode: 1 });
    expect(extractSubscriptionCliFailureTags(err)).toEqual({ cli_failure: "limit_reached", cli_exit_code: "1" });
  });

  it("names the other CLI failures by their class", () => {
    expect(extractSubscriptionCliFailureTags(new SubscriptionCliNotInstalledError("claude"))).toEqual({ cli_failure: "not_installed" });
    expect(extractSubscriptionCliFailureTags(new SubscriptionCliAuthError("codex", "Run codex login."))).toEqual({ cli_failure: "not_signed_in" });
    expect(extractSubscriptionCliFailureTags(new SubscriptionCliCommandLineError("too long", "too-long"))).toEqual({ cli_failure: "command_line_too_long" });
  });

  it("finds the CLI error under a wrapper", () => {
    const wrapper = Object.assign(new Error("transport"), { name: "TransportError", cause: failure() });
    expect(extractSubscriptionCliFailureTags(wrapper)?.cli_failure).toBe("exited");
  });

  it("is undefined for an error that is not a CLI one", () => {
    expect(extractSubscriptionCliFailureTags(new TypeError("x"))).toBeUndefined();
    expect(extractSubscriptionCliFailureTags(null)).toBeUndefined();
  });

  it("does not trust a kind or an exit code it does not know", () => {
    const forged = Object.assign(new SubscriptionCliInvocationError("boom", 1), { failureKind: "a sentence of user text" });
    expect(extractSubscriptionCliFailureTags(forged)?.cli_failure).toBe("unknown");
    const odd = Object.assign(new SubscriptionCliInvocationError("boom"), { exitCode: 1.5 });
    expect(extractSubscriptionCliFailureTags(odd)).toEqual({ cli_failure: "exited" });
  });

  it("reaches the Sentry tags without the stderr text, the binary or its path", () => {
    const err = failure();
    const tags = tagsOf(err);
    expect(tags.cli_failure).toBe("exited");
    expect(tags.cli_exit_code).toBe("1");
    const body = buildEnvelope(DSN, scrubError(err, { source: "llm_failure" }), META).body;
    expect(body).not.toContain("notes.md");
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain("/opt/tools");
    expect(body).not.toContain("SECRET");
  });

  it("keeps the fingerprint as it was", () => {
    const err = failure();
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.cliFailureTags).toBeDefined();
    const withoutTags = { ...ev };
    delete withoutTags.cliFailureTags;
    expect(buildFingerprint(ev)).toEqual(buildFingerprint(withoutTags));
  });
});
