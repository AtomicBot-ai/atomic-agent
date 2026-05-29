import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  input?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Runs an external command with timeout + output-size cap + abort signal.
 * Both stdout and stderr are captured as UTF-8 strings; binary-only tools
 * are not part of the MVP scope. This runner is used by run_test as well
 * as by git plumbing inside the sandbox.
 *
 * Timeout semantics: when `timeoutMs` is omitted it falls back to 60s.
 * A non-positive or non-finite `timeoutMs` (e.g. `0`) disables the timeout
 * entirely — the command runs unbounded and is only stoppable via the abort
 * signal. Long-running tools (e.g. `brew install`) rely on this.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killIt = (reason: "timeout" | "abort") => {
      if (settled) return;
      timedOut = reason === "timeout";
      try {
        child.kill("SIGKILL");
      } catch {
        // process already exited
      }
    };

    const timer =
      timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? setTimeout(() => killIt("timeout"), timeoutMs)
        : null;
    const onAbort = () => killIt("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxOutputBytes) {
        const slice = chunk.slice(0, Math.max(0, maxOutputBytes - stdoutBytes));
        if (slice.length > 0) {
          chunks.stdout.push(slice);
          stdoutBytes += slice.length;
        }
        truncated = true;
        return;
      }
      chunks.stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > maxOutputBytes) {
        const slice = chunk.slice(0, Math.max(0, maxOutputBytes - stderrBytes));
        if (slice.length > 0) {
          chunks.stderr.push(slice);
          stderrBytes += slice.length;
        }
        truncated = true;
        return;
      }
      chunks.stderr.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        args,
        exitCode: code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
