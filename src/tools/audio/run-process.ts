import { execFile } from "node:child_process";

/** What one finished child process left behind. */
export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start or was killed (timeout, abort). */
  error?: string;
}

export type RunProcess = (
  cmd: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<ProcessResult>;

/** Transcripts of long recordings are big; stdout beyond this is cut by Node. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * `execFile` with no shell: argv goes to the binary as given, so a file
 * name with spaces or quotes is one argument. Never rejects.
 */
export const runProcess: RunProcess = (cmd, args, options) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: e.killed ? "stopped (timed out or cancelled)" : e.message,
        });
      },
    );
  });
