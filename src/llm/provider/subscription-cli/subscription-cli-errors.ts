/**
 * Failure taxonomy for CLI-backed providers. The three cases the user
 * can actually act on are kept apart from each other: the binary is
 * missing, the CLI is signed out, or the invocation itself failed.
 */

export class SubscriptionCliNotInstalledError extends Error {
  /**
   * `productName` words it for someone who picked a subscription in a
   * menu and has never heard of PATH: "Claude Code isn't installed (the
   * `claude` command was not found)." Without it, the terse form.
   */
  constructor(binary: string, installHint = "", productName?: string) {
    // Trimmed: the Windows shim raises this for a configured `binPath`
    // that is not on disk and has no hint of its own to add.
    super(
      (productName
        ? `${productName} isn't installed (the \`${binary}\` command was not found). ${installHint}`
        : `"${binary}" was not found on PATH. ${installHint}`
      ).trim(),
    );
    this.name = "SubscriptionCliNotInstalledError";
  }
}

/**
 * The binary exists but the OS refused to start it. In practice that is
 * Windows declining a `.cmd`/`.bat` shim spawned without a shell; kept
 * apart from "not installed" because reinstalling would not help.
 */
export class SubscriptionCliSpawnError extends Error {
  constructor(binary: string, installHint: string) {
    super(
      `"${binary}" could not be started (spawn EINVAL) — on Windows a .cmd/.bat shim cannot be spawned directly. ${installHint}`,
    );
    this.name = "SubscriptionCliSpawnError";
  }
}

/**
 * The invocation cannot be expressed as a `cmd.exe` command line at all,
 * so it is refused before anything is spawned.
 *
 * Both reasons are silent corruption if they are let through: past
 * cmd's 8191-character limit cmd answers "The input line is too long."
 * and the CLI never runs, and a raw newline inside an argument ends the
 * command line where it stands — cmd would run the tail as a second
 * command. Neither has an escape, so the only honest answer is to say
 * what happened rather than send a command line that means something
 * else than the caller asked for.
 */
export type CliCommandLineRejection = "too-long" | "control-character";

export class SubscriptionCliCommandLineError extends Error {
  readonly reason: CliCommandLineRejection;
  constructor(message: string, reason: CliCommandLineRejection) {
    super(message);
    this.name = "SubscriptionCliCommandLineError";
    this.reason = reason;
  }
}

export class SubscriptionCliAuthError extends Error {
  constructor(binary: string, authHint: string, detail?: string) {
    super(
      `"${binary}" is not signed in. ${authHint}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "SubscriptionCliAuthError";
  }
}

export class SubscriptionCliInvocationError extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.name = "SubscriptionCliInvocationError";
    this.exitCode = exitCode;
  }
}

/**
 * Signed-out CLIs do not use a stable exit code, so the text is the only
 * signal. Kept deliberately narrow: a false positive here would relabel
 * a real API error as "run /login" and send the user down a dead end.
 */
const AUTH_PATTERNS = [
  /\bplease run\s+\/login\b/i,
  /\brun\s+`?\/login`?\b/i,
  /\bnot (?:logged in|authenticated|signed in)\b/i,
  /\bauthentication (?:required|failed|error)\b/i,
  /\binvalid api key\b/i,
  /\bunauthorized\b/i,
  /\bcredentials (?:are )?(?:missing|expired|invalid)\b/i,
];

export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

/**
 * A CLI-backed link that cannot serve until the user does something:
 * the binary is not installed, or the CLI is signed out. Nothing about
 * either changes by waiting or retrying, so the turn must end on it at
 * once rather than park in the outage wait (ATO-117: a Windows user
 * without `claude` read "no connection" for five minutes).
 *
 * Walks `cause`: the step executor hands the agent loop a
 * `TransportError` wrapping the original.
 */
export function isSubscriptionCliSetupError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current instanceof SubscriptionCliNotInstalledError ||
      current instanceof SubscriptionCliAuthError
    ) {
      return true;
    }
    if (typeof current !== "object" || current === null) return false;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}

/** `spawn` reports a missing binary as an ENOENT on the error event. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * A spawn that failed with EINVAL. Node hands EACCES/EAGAIN/EMFILE/
 * ENFILE/ENOENT to the async `error` event and *throws* every other
 * errno straight out of `ChildProcess.prototype.spawn`, so unlike an
 * ENOENT this one arrives synchronously and has to be caught at the
 * call site rather than on the child.
 */
export function isSpawnEinval(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (code !== "EINVAL") return false;
  return syscall === undefined || syscall === "spawn";
}

export interface CliFailureInput {
  binary: string;
  installHint: string;
  authHint: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** The CLI stopped reading stdin before the prompt was fully written. */
  inputTruncated?: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

const DETAIL_CHARS = 2048;

/**
 * Turn a finished-but-unhappy CLI run into a typed error. Callers hand
 * the raw streams over verbatim: subscription rate-limit messages have
 * no documented structured form, so swallowing the text would leave the
 * user with an exit code and no explanation.
 */
export function mapCliFailure(input: CliFailureInput): Error {
  if (input.timedOut) {
    return new SubscriptionCliInvocationError(
      `"${input.binary}" timed out after ${input.timeoutMs}ms`,
      input.exitCode,
    );
  }
  if (input.truncated) {
    return new SubscriptionCliInvocationError(
      `"${input.binary}" produced more than ${input.maxOutputBytes} bytes; refusing to parse a truncated response`,
      input.exitCode,
    );
  }
  const combined = `${input.stderr}\n${input.stdout}`;
  if (looksLikeAuthFailure(combined)) {
    return new SubscriptionCliAuthError(
      input.binary,
      input.authHint,
      tail(input.stderr || input.stdout),
    );
  }
  // Checked after the auth patterns: a signed-out CLI is what usually
  // drops the pipe, and "run /login" is the more actionable message.
  if (input.inputTruncated) {
    return new SubscriptionCliInvocationError(
      `"${input.binary}" stopped reading the prompt before it was fully written (exit ${
        input.exitCode ?? "null"
      }): ${tail(input.stderr || input.stdout) || "no output"}`,
      input.exitCode,
    );
  }
  return new SubscriptionCliInvocationError(
    `"${input.binary}" exited with code ${input.exitCode ?? "null"}: ${
      tail(input.stderr || input.stdout) || "no output"
    }`,
    input.exitCode,
  );
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_CHARS
    ? `…${trimmed.slice(-DETAIL_CHARS)}`
    : trimmed;
}
