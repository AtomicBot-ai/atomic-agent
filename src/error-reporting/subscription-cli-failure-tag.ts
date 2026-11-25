/**
 * The `cli_failure`, `cli_exit_code` and `cli_reason` tags of an error
 * report (ATO-1446, ATO-1679).
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
 *  - `cli_exit_code`: the CLI's exit code, a bounded integer;
 *  - `cli_reason`: for a run that failed with the CLI's own words
 *    (`exited`, `input_truncated`, `reported_error`, `turn_failed`),
 *    what those words say, as one fixed word from `CLI_REASONS`. The
 *    message is matched here, on the machine, and only the word leaves.
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

/** Kinds whose message carries the CLI's own text. Mirror of `KINDS_WITH_CLI_TEXT` in `subscription-cli-errors.ts`. */
const KINDS_WITH_CLI_TEXT: ReadonlySet<string> = new Set([
  "exited",
  "reported_error",
  "turn_failed",
]);

/**
 * Kinds that get a `cli_reason`: those above plus `input_truncated`,
 * whose message also ends with the CLI's own text (an old CLI or a
 * missing git-bash exits before reading a long prompt).
 */
const KINDS_WITH_REASON: ReadonlySet<string> = new Set([
  ...KINDS_WITH_CLI_TEXT,
  "input_truncated",
]);

/** Every value `cli_reason` can take. */
export const CLI_REASONS = [
  "git_bash_missing",
  "node_missing",
  "unknown_option",
  "command_not_recognized",
  "path_not_found",
  "no_output",
  "other",
] as const;

export type CliReason = (typeof CLI_REASONS)[number];

/**
 * Checked in order, first match wins. Narrow on purpose: a miss is
 * `other`, which is honest, while a wrong word would send whoever reads
 * the report down the wrong path. `unknown_option` and
 * `git_bash_missing` are mirrored in
 * `src/llm/provider/subscription-cli/cli-exit-hint.ts`, which adds a
 * plain-words next step for those two to the message.
 */
const REASON_PATTERNS: ReadonlyArray<readonly [CliReason, readonly RegExp[]]> = [
  // Claude Code on Windows without Git for Windows.
  ["git_bash_missing", [/\brequires git-bash\b/i, /\bCLAUDE_CODE_GIT_BASH_PATH\b/]],
  // A `#!/usr/bin/env node` shim or a cmd shim with no Node to run it.
  [
    "node_missing",
    [
      /\benv: ['"]?node['"]?: No such file or directory/i,
      /'node' is not recognized as an internal or external command/i,
      /\bnode: (?:command )?not found\b/i,
      /\bcommand not found: node\b/i,
    ],
  ],
  // Commander ("unknown option '--x'") and clap ("unexpected argument
  // '--x' found", "error: unrecognized ...") refusing one of our flags.
  ["unknown_option", [/\bunknown option\b/i, /\bunexpected argument\b/i, /\berror: unrecognized\b/i]],
  ["command_not_recognized", [/is not recognized as an internal or external command/i]],
  ["path_not_found", [/\bcannot find the (?:path|file) specified\b/i]],
  // `mapCliFailure` writes "no output" when stderr and stdout were empty.
  ["no_output", [/:\s*no output\s*$/i]],
];

/** One word for what a CLI failure message says. Never any of the text itself. */
export function classifyCliReason(message: string): CliReason {
  for (const [reason, patterns] of REASON_PATTERNS) {
    if (patterns.some((re) => re.test(message))) return reason;
  }
  return "other";
}

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** Exit codes up to Windows' 32-bit NTSTATUS values (3221225477). */
const MAX_EXIT_CODE = 0xffffffff;

/** `cli_failure`, plus `cli_exit_code` and `cli_reason` when they apply. */
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
    if (typeof kind === "string" && KINDS_WITH_REASON.has(kind)) {
      const message = e.message;
      tags.cli_reason = typeof message === "string" ? classifyCliReason(message) : "other";
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
