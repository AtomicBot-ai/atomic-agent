/**
 * Turn `imsg` failures into something the operator can act on.
 *
 * The CLI needs two separate macOS privacy grants and is installed by
 * the user, so "it does not work" almost always means one of three
 * things: the binary is not on PATH, the app running atomic-agent has
 * no Full Disk Access (no reading `chat.db`), or it has no Automation
 * permission for Messages (no sending). Each gets its own hint.
 *
 * The phrases matched below come from imsg's troubleshooting guide
 * (`unable to open database file`, `not authorized to send Apple
 * events`) and from macOS itself (Apple Event error -1743 is
 * "errAEEventNotPermitted"). They are matched loosely and in one place
 * so a wording change in a future imsg release is a one-line fix.
 */

export type ImsgFailureKind = "missing" | "disk-access" | "automation" | "other";

export interface ImsgFailure {
  kind: ImsgFailureKind;
  /** One line for `lastError`: what is wrong and what to do. */
  message: string;
}

export const IMSG_INSTALL_HINT =
  "imsg is not installed or not on PATH. Install it with `brew install steipete/tap/imsg` " +
  "(macOS 14+), or set channels.imessage.options.binary to its full path.";

export const IMSG_DISK_ACCESS_HINT =
  "imsg cannot read the Messages database. Give Full Disk Access to the app that runs " +
  "atomic-agent (your terminal, or Atomic Agent desktop) in System Settings > Privacy & " +
  "Security > Full Disk Access, then restart it.";

export const IMSG_AUTOMATION_HINT =
  "imsg is not allowed to control Messages. Turn on the app that runs atomic-agent under " +
  "System Settings > Privacy & Security > Automation > Messages.";

const DISK_ACCESS_PATTERNS = [
  /unable to open database/i,
  /authorization denied/i,
  /full disk access/i,
  /operation not permitted/i,
];

const AUTOMATION_PATTERNS = [
  /not authori[sz]ed to send apple events/i,
  /-1743\b/,
  /\bautomation\b/i,
];

/**
 * Classify a failure from `imsg`. `err` is what `spawn`/`execFile`
 * reported (an `ENOENT` code means the binary is missing); `stderr` is
 * whatever the child printed, if anything.
 */
export function classifyImsgFailure(err: unknown, stderr = ""): ImsgFailure {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return { kind: "missing", message: IMSG_INSTALL_HINT };
  const text = `${stderr}\n${err instanceof Error ? err.message : err == null ? "" : String(err)}`;
  if (DISK_ACCESS_PATTERNS.some((re) => re.test(text))) {
    return { kind: "disk-access", message: IMSG_DISK_ACCESS_HINT };
  }
  if (AUTOMATION_PATTERNS.some((re) => re.test(text))) {
    return { kind: "automation", message: IMSG_AUTOMATION_HINT };
  }
  return { kind: "other", message: `imsg failed: ${firstLine(scrubImessageError(text))}` };
}

/**
 * Remove what must not reach logs or `lastError`: phone numbers and
 * e-mail addresses (imsg echoes recipients in its errors) and anything
 * shaped like a long secret. There are no tokens in this channel, but
 * the same rule as every other channel keeps it that way.
 */
export function scrubImessageError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "<phone>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>");
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "unknown error";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
