import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

import { isPortAnswering } from "./daemon-launch-guard.js";

/**
 * Wait for a stopped model server to really let go of its port.
 *
 * On Windows `taskkill /F` returns before the process has exited and
 * its listening socket is closed, and Atomic Core's unload of its own
 * llama-server can return the same way. A model switch then started the
 * next server on the same port at once, and it failed with "address
 * already in use" (ATO-304, ATO-278). The POSIX stop already waits for
 * the pid to go; this waits for the pid AND the port, bounded, and the
 * caller carries on as before when the bound runs out.
 */

/** The wait's bound when the caller names none, as the POSIX stop's grace. */
export const RELEASE_WAIT_MS = 3000;

export interface ReleaseWaitDeps {
  pidAlive?: (pid: number) => boolean;
  portOpen?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type ReleaseWaitResult =
  | { released: true; waitedMs: number }
  | { released: false; waitedMs: number; holding: "process" | "port" };

/**
 * Resolve once `pid` is gone and nothing holds `port` (a `null` port
 * waits for the process alone), or when `timeoutMs` runs out. Never
 * throws and never signals anything: it only watches.
 */
export async function waitForProcessRelease(
  pid: number,
  port: number | null,
  opts: { timeoutMs?: number; pollMs?: number } = {},
  deps: ReleaseWaitDeps = {},
): Promise<ReleaseWaitResult> {
  const alive = deps.pidAlive ?? isPidAlive;
  const open = deps.portOpen ?? isPortHeld;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? RELEASE_WAIT_MS;
  const pollMs = opts.pollMs ?? 100;
  const start = now();
  for (;;) {
    // The port is read only once the process is gone: while it lives,
    // it holds the port, and a bind probe would only race its exit.
    const holding: "process" | "port" | null = alive(pid)
      ? "process"
      : port !== null && (await open(port))
        ? "port"
        : null;
    const waitedMs = now() - start;
    if (holding === null) return { released: true, waitedMs };
    if (waitedMs >= timeoutMs) return { released: false, waitedMs, holding };
    await sleep(pollMs);
  }
}

/**
 * Append one line to a server log when the wait ran out, so a start
 * failing on the port right after it reads as this and not a mystery.
 * Best effort: a log that cannot be written changes nothing.
 */
export function noteReleaseTimeout(
  logPath: string,
  pid: number,
  port: number | null,
  result: ReleaseWaitResult,
): void {
  if (result.released) return;
  const what =
    result.holding === "process"
      ? `pid ${pid} was still running`
      : `port ${port} was still in use`;
  try {
    appendFileSync(
      logPath,
      `\n[atomic-agent] stop: ${what} ${result.waitedMs}ms after the stop; carrying on\n`,
    );
  } catch {
    /* no note: the start below reports its own failure */
  }
}

/** Signal 0: gone only on ESRCH-like failures; EPERM means alive (another user's). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** Open = something accepts on it: an HTTP answer, or a bind that fails. */
export async function isPortOpen(port: number): Promise<boolean> {
  if (await isPortAnswering(port, 800)) return true;
  return (await probeBind(port)) !== "free";
}

/**
 * The release wait's probe: can the next server bind the port? The bind
 * goes first because it is what the next start needs and it answers at
 * once; an HTTP probe of a closed loopback port can take about a second
 * on Windows. Only a bind that fails for a reason other than "in use"
 * falls back to asking HTTP.
 */
export async function isPortHeld(port: number): Promise<boolean> {
  const bind = await probeBind(port);
  if (bind !== "unknown") return bind === "in_use";
  return isPortAnswering(port, 800);
}

type BindProbe = "free" | "in_use" | "unknown";

/** Bind 127.0.0.1:`port` and let go; bounded so a stuck listen cannot hold the wait. */
function probeBind(port: number, timeoutMs = 1000): Promise<BindProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    const timer = setTimeout(() => {
      server.close();
      resolve("unknown");
    }, timeoutMs);
    server.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES" ? "in_use" : "unknown");
    });
    server.listen(port, "127.0.0.1", () => {
      clearTimeout(timer);
      server.close(() => resolve("free"));
    });
  });
}
