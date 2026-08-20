/**
 * Failure taxonomy for CLI-backed providers. The three cases the user
 * can actually act on are kept apart from each other: the binary is
 * missing, the CLI is signed out, or the invocation itself failed.
 */

export class SubscriptionCliNotInstalledError extends Error {
  constructor(binary: string, installHint: string) {
    super(`"${binary}" was not found on PATH. ${installHint}`);
    this.name = "SubscriptionCliNotInstalledError";
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

/** `spawn` reports a missing binary as an ENOENT on the error event. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
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
