import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { win32 } from "node:path";

import { taskkillPath } from "../platform.js";

/**
 * Throwaway directories that a second copy of the app ran in (T03's
 * `--first-run-probe`, T30's second window), and what to do when that copy
 * is gone or has to be ended.
 *
 * On Windows a directory cannot be removed while any process still holds a
 * file in it, and a Chromium profile is held by the app's helper processes
 * (GPU, network, renderer) for a moment after the main process ends. Ending
 * the main process alone (`child.kill`, execFile's timeout) also leaves those
 * helpers, and anything else the copy started, running. A plain
 * `rmSync(dir, { recursive: true })` in a `finally` then throws EPERM, and
 * that throw ends the whole task: every check after it is lost and the run
 * shows only "its checks ran to the end — EPERM". So:
 *
 *   - `runSecondCopy` waits for the copy's own exit, not for its stdout to
 *     close (a grandchild that inherited the pipe keeps it open on Windows),
 *     and ends the whole tree on its timeout;
 *   - `holdersOf` names what still runs with the directory on its command
 *     line, so a check can say who held it;
 *   - `endTree` ends those, and `removeDir` retries the removal and reports a
 *     failure instead of throwing it.
 */

export interface Holder { pid: number; name: string; commandLine: string }

const powershell = (systemRoot?: string) =>
  win32.join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Windows: end `pid` and every process it started. Elsewhere: SIGKILL the one pid. */
export function endTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(taskkillPath(process.env.SystemRoot), ["/PID", String(pid), "/T", "/F"], { timeout: 10_000, windowsHide: true }, () => resolve());
  });
}

/**
 * The processes (other than this one) whose command line names `dir`.
 * Windows only: that is where a holder stops the removal. Empty elsewhere,
 * and when the query itself fails.
 */
export function holdersOf(dir: string): Promise<Holder[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const needle = dir.replace(/'/g, "''");
  const script =
    `$d = '${needle}'; ` +
    "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
    "Select-Object ProcessId, Name, CommandLine) | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(powershell(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout) as unknown;
        const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId?: number; Name?: string; CommandLine?: string }>;
        resolve(rows
          .filter((r) => typeof r.ProcessId === "number" && r.ProcessId !== process.pid && !/powershell/i.test(r.Name ?? ""))
          .map((r) => ({ pid: r.ProcessId as number, name: r.Name ?? "", commandLine: r.CommandLine ?? "" })));
      } catch {
        resolve([]);
      }
    });
  });
}

/** One line per holder for a check's detail: pid, name and the start of its command line. */
export function describeHolders(holders: Holder[]): string {
  return holders.map((h) => `${h.pid} ${h.name} ${JSON.stringify(h.commandLine.slice(0, 200))}`).join("; ");
}

/** Remove `dir`, retrying while Windows still holds it. Null when it is gone, else the error, never thrown. */
export async function removeDir(dir: string): Promise<string | null> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface SecondCopyResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }

/**
 * Run a second copy of this app (`process.execPath args`) to its own exit.
 * On `timeoutMs` the copy and everything it started are ended. Resolves on
 * the copy's exit, so a grandchild still holding the stdout pipe does not
 * keep the caller waiting.
 */
export function runSecondCopy(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<SecondCopyResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", (b: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-8000); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void endTree(child.pid);
    }, timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      // The last chunk of stdout can trail the exit by a tick.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ stdout, stderr, code, timedOut });
      }, 200);
    };
    child.once("exit", (code) => done(code));
    child.once("error", (err) => { stderr += `\n${err.message}`; done(null); });
  });
}
