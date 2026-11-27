import type { ShellJobRecord } from "./shell-jobs.js";

/**
 * Reading what an interactive job prints after input is typed into it:
 * shared by `{"write": id, "text"}` (shell-job-write.ts, ATO-2277) and
 * `{"write": id, "secret"}` (shell-job-secret.ts, ATO-2486).
 */

/** How long a write waits for the reply by default, and at most. */
export const WRITE_DEFAULT_WAIT_MS = 2_000;
export const WRITE_MAX_WAIT_MS = 60_000;
/** The reply is taken as complete after this much quiet. */
export const WRITE_QUIET_MS = 500;

/** The wait a call asked for, bounded; the default when it asked for none. */
export function writeWaitMs(timeoutMs: unknown): number {
  return Math.min(
    WRITE_MAX_WAIT_MS,
    typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : WRITE_DEFAULT_WAIT_MS,
  );
}

/** Terminal colour and cursor codes and carriage returns, out of what the model reads. */
export function stripTerminalCodes(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\r\n?/g, "\n");
}

/** Collect what the job prints for up to `ms`, until it goes quiet or exits. */
export function readReply(record: ShellJobRecord, ms: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      clearTimeout(limit);
      if (quiet) clearTimeout(quiet);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve(text);
    };
    const limit = setTimeout(finish, ms);
    const unsubscribe = record.job.onOutput((chunk) => {
      text += chunk;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(finish, WRITE_QUIET_MS);
    });
    signal.addEventListener("abort", finish, { once: true });
    record.job.exit.then(finish, finish);
  });
}
