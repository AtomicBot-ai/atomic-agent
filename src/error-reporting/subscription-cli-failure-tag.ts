/**
 * The `cli_failure` and `cli_exit_code` tags of an error report
 * (ATO-1446).
 *
 * A failed Claude Code or Codex run reached Sentry as a bare
 * `SubscriptionCliInvocationError`: its message holds the CLI's own
 * stderr, and the scrubber never sends a message, so the report said
 * nothing about why. These tags say it in fixed words:
 *
 *  - `cli_failure`: `timeout`, `limit_reached`, `exited`, … read off
 *    `SubscriptionCliInvocationError.failureKind`, or `not_installed`,
 *    `not_signed_in`, `spawn_failed`, `command_line_too_long`,
 *    `command_line_control_character` for the other CLI error classes;
 *  - `cli_exit_code`: the CLI's exit code, a bounded integer.
 *
 * Read by class name, so this module takes no import from the LLM
 * layer, and walked through `cause`: the step executor hands the report
 * a `TransportError` wrapping the CLI error. Never the message, the
 * stderr, the binary or its path.
 */

/** Mirror of `SubscriptionCliFailureKind` in `src/llm/provider/subscription-cli/subscription-cli-errors.ts`. */
const KNOWN_INVOCATION_KINDS: ReadonlySet<string> = new Set([
  "timeout",
  "output_too_large",
  "input_truncated",
  "exited",
  "limit_reached",
  "not_json",
  "reported_error",
  "turn_failed",
]);

/** The CLI error classes that need no field to say what happened. */
const KIND_BY_CLASS: ReadonlyMap<string, string> = new Map([
  ["SubscriptionCliNotInstalledError", "not_installed"],
  ["SubscriptionCliAuthError", "not_signed_in"],
  ["SubscriptionCliSpawnError", "spawn_failed"],
]);

/** Mirror of `CliCommandLineRejection`. */
const COMMAND_LINE_KINDS: ReadonlyMap<string, string> = new Map([
  ["too-long", "command_line_too_long"],
  ["control-character", "command_line_control_character"],
]);

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** Exit codes up to Windows' 32-bit NTSTATUS values (3221225477). */
const MAX_EXIT_CODE = 0xffffffff;

/** `cli_failure`, and `cli_exit_code` when the CLI exited with one. */
export type SubscriptionCliFailureTags = Record<string, string>;

/** The tags for an error, or `undefined` when no CLI error is on its chain. */
export function extractSubscriptionCliFailureTags(
  err: unknown,
): SubscriptionCliFailureTags | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const tags = tagsOf(current as Record<string, unknown>);
    if (tags !== undefined) return tags;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}

function tagsOf(e: Record<string, unknown>): SubscriptionCliFailureTags | undefined {
  const name = e.name;
  if (name === "SubscriptionCliInvocationError") {
    const kind = e.failureKind;
    const tags: SubscriptionCliFailureTags = {
      cli_failure:
        typeof kind === "string" && KNOWN_INVOCATION_KINDS.has(kind) ? kind : "unknown",
    };
    const exitCode = e.exitCode;
    if (
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      Math.abs(exitCode) <= MAX_EXIT_CODE
    ) {
      tags.cli_exit_code = String(exitCode);
    }
    return tags;
  }
  if (name === "SubscriptionCliCommandLineError") {
    const reason = e.reason;
    const rejection = typeof reason === "string" ? COMMAND_LINE_KINDS.get(reason) : undefined;
    return { cli_failure: rejection ?? "command_line_rejected" };
  }
  const classKind = typeof name === "string" ? KIND_BY_CLASS.get(name) : undefined;
  if (classKind !== undefined) return { cli_failure: classKind };
  return undefined;
}
