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
import { CLI_REASONS, classifyCliReason, extractSubscriptionCliFailureTags } from "./subscription-cli-failure-tag.js";

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
    expect(extractSubscriptionCliFailureTags(failure())).toEqual({ cli_failure: "exited", cli_exit_code: "1", cli_reason: "other" });
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
    expect(extractSubscriptionCliFailureTags(odd)).toEqual({ cli_failure: "exited", cli_reason: "other" });
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

describe("cli_reason tag (ATO-1679)", () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ["unknown_option", "error: unknown option '--strict-mcp-config'"],
    ["unknown_option", "error: unexpected argument '--output-schema' found"],
    ["unknown_option", "error: unrecognized subcommand 'exec'"],
    [
      "git_bash_missing",
      "Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe",
    ],
    ["node_missing", "env: node: No such file or directory"],
    ["node_missing", "'node' is not recognized as an internal or external command,\r\noperable program or batch file."],
    ["node_missing", "/usr/local/bin/claude: 2: exec: node: not found"],
    ["node_missing", "zsh: command not found: node"],
    ["command_not_recognized", "'claude' is not recognized as an internal or external command,\r\noperable program or batch file."],
    ["path_not_found", "The system cannot find the path specified."],
    ["path_not_found", "The system cannot find the file specified."],
    ["other", "Segmentation fault"],
  ];

  it.each(CASES)("reads %s out of the CLI's text", (reason, stderr) => {
    const err = failure({ binary: "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd", stderr });
    expect(extractSubscriptionCliFailureTags(err)).toEqual({ cli_failure: "exited", cli_exit_code: "1", cli_reason: reason });
  });

  it("says no_output when the CLI printed nothing", () => {
    expect(extractSubscriptionCliFailureTags(failure({ stderr: "" }))?.cli_reason).toBe("no_output");
    expect(classifyCliReason('"claude" exited with code 1: no output')).toBe("no_output");
  });

  it("covers every word in the vocabulary", () => {
    const seen = new Set([...CASES.map(([reason]) => reason), "no_output"]);
    expect([...seen].sort()).toEqual([...CLI_REASONS].sort());
  });

  it("is always a word from the vocabulary, never the text", () => {
    const err = failure({ stderr: `error: unknown option '--x' ${STDERR}` });
    const reason = extractSubscriptionCliFailureTags(err)?.cli_reason;
    expect(reason).toBe("unknown_option");
    expect(CLI_REASONS).toContain(reason);
    for (const value of Object.values(extractSubscriptionCliFailureTags(err) ?? {})) {
      expect(value).not.toMatch(/notes\.md|SECRET|--x|\/Users\//);
    }
    const forged = new SubscriptionCliInvocationError(STDERR, 1, "exited");
    expect(CLI_REASONS).toContain(extractSubscriptionCliFailureTags(forged)?.cli_reason);
  });

  it("reads the CLI's words for reported_error and turn_failed too", () => {
    const reported = new SubscriptionCliInvocationError("claude reported error: unknown option '--json-schema'", null, "reported_error");
    expect(extractSubscriptionCliFailureTags(reported)).toEqual({ cli_failure: "reported_error", cli_reason: "unknown_option" });
    const turn = new SubscriptionCliInvocationError("codex turn failed: stream disconnected", null, "turn_failed");
    expect(extractSubscriptionCliFailureTags(turn)).toEqual({ cli_failure: "turn_failed", cli_reason: "other" });
  });

  it("adds no reason to a failure that carries none of the CLI's words", () => {
    expect(extractSubscriptionCliFailureTags(failure({ timedOut: true, exitCode: null }))).toEqual({ cli_failure: "timeout" });
    expect(extractSubscriptionCliFailureTags(failure({ truncated: true }))?.cli_reason).toBeUndefined();
    const limit = failure({ stderr: "Claude AI usage limit reached|1762000000" });
    expect(extractSubscriptionCliFailureTags(limit)).toEqual({ cli_failure: "limit_reached", cli_exit_code: "1" });
    expect(extractSubscriptionCliFailureTags(new SubscriptionCliNotInstalledError("claude"))).toEqual({ cli_failure: "not_installed" });
  });

  it("reaches the Sentry tags without the text and leaves the fingerprint alone", () => {
    const err = failure({ stderr: "error: unknown option '--strict-mcp-config'\n/Users/someone/secret-project" });
    expect(tagsOf(err).cli_reason).toBe("unknown_option");
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.cliFailureTags?.cli_reason).toBe("unknown_option");
    const body = buildEnvelope(DSN, ev, META).body;
    expect(body).not.toContain("strict-mcp-config");
    expect(body).not.toContain("secret-project");
    const withoutTags = { ...ev };
    delete withoutTags.cliFailureTags;
    expect(buildFingerprint(ev)).toEqual(buildFingerprint(withoutTags));
    const other = scrubError(failure({ stderr: "Segmentation fault" }), { source: "llm_failure" });
    expect(other.cliFailureTags?.cli_reason).toBe("other");
    expect(buildFingerprint(other)).toEqual(buildFingerprint(ev));
  });
});

describe("cli_reason agrees with the hint in the message (ATO-1679)", () => {
  const UNKNOWN = "error: unknown option '--strict-mcp-config'";
  const GIT_BASH =
    "Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe";
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ["unknown_option", UNKNOWN, "may be older than this version of Atomic Agent needs"],
    ["git_bash_missing", GIT_BASH, "needs Git for Windows (git-bash)"],
  ];

  for (const inputTruncated of [false, true]) {
    const kind = inputTruncated ? "input_truncated" : "exited";
    it.each(CASES)(`gives %s with the hint for ${kind}`, (reason, stderr, hint) => {
      const err = failure({ binary: "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd", stderr, inputTruncated });
      expect(err).toBeInstanceOf(SubscriptionCliInvocationError);
      expect((err as SubscriptionCliInvocationError).failureKind).toBe(kind);
      expect(err.message).toContain(hint);
      expect(classifyCliReason(err.message)).toBe(reason);
      expect(extractSubscriptionCliFailureTags(err)).toEqual({ cli_failure: kind, cli_exit_code: "1", cli_reason: reason });
    });
  }

  it("agrees when the flag error scrolled out of a long stderr: no hint and other", () => {
    // The message keeps only the last 2048 characters of stderr, and the
    // hint reads that same text, so neither sees the flag error.
    const err = failure({ stderr: `${UNKNOWN}\n${"x".repeat(3000)}` });
    expect(err.message).not.toContain("unknown option");
    expect(err.message).not.toContain("may be older");
    expect(classifyCliReason(err.message)).toBe("other");
  });

  it("agrees when the flag error is at the end of a long stderr: hint and unknown_option", () => {
    const err = failure({ stderr: `${"x".repeat(3000)}\n${UNKNOWN}` });
    expect(err.message).toContain("may be older");
    expect(classifyCliReason(err.message)).toBe("unknown_option");
  });
});
