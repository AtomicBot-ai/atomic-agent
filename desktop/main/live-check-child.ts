/**
 * ATO-1684: waits for one live-check child and turns it into a RunOutcome.
 * No electron import, so the unit suite loads it.
 *
 * The deadline settles the outcome itself instead of waiting for `close`.
 * On Windows the child is cmd.exe; killing it leaves the CLI grandchild
 * holding the pipes, so `close` may never come, and a check that never
 * settles would hang the cached answer and every "Check again".
 */

import type { RunOutcome } from "./subscription-cli-live-check.js";

/** What this needs from a spawned ChildProcess. */
export interface LiveCheckChild {
  stdout?: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  stderr?: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  once(event: "error", cb: (err: NodeJS.ErrnoException) => void): unknown;
  once(event: "close", cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export function collectLiveCheckChild(
  child: LiveCheckChild,
  timeoutMs: number,
  maxOutput: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (o: Omit<RunOutcome, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...o, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ code: null });
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { if (stdout.length < maxOutput) stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { if (stderr.length < maxOutput) stderr += b.toString("utf8"); });
    child.once("error", (err: NodeJS.ErrnoException) => done({ code: null, spawnError: err.code ?? "spawn_failed" }));
    child.once("close", (code: number | null) => done({ code }));
  });
}
