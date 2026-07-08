import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { mkdir } from "node:fs/promises";

/**
 * Spawn a Chromium-family browser with the given args and wait until
 * the DevTools Protocol HTTP endpoint starts responding. Returns both
 * the child process (so the caller can kill it on shutdown) and the
 * resolved CDP base URL (`http://127.0.0.1:<port>`) which Playwright
 * can `connectOverCDP` to.
 *
 * Crucially this does **not** go through Playwright's own launcher;
 * Playwright would otherwise inject `--enable-automation` and a handful
 * of detectable tweaks. By driving `spawn()` ourselves Chrome looks
 * indistinguishable from a user-started instance.
 */

export interface SpawnChromeInput {
  executablePath: string;
  args: readonly string[];
  cdpPort: number;
  userDataDir: string;
  /** Overall budget for "process started + CDP reachable" checks. */
  readinessTimeoutMs: number;
  /** How long between successive readiness probes. */
  pollIntervalMs?: number;
}

export interface RunningChrome {
  proc: ChildProcess;
  cdpUrl: string;
}

/**
 * Kill a process and its descendants. On Windows `proc.kill` only signals
 * the direct child, leaving Chrome's helper processes (GPU, renderers)
 * orphaned; `taskkill /T /F` walks the whole tree. Falls back to SIGKILL
 * when the pid is gone or taskkill cannot be spawned.
 */
function killProcessTree(proc: ChildProcess): void {
  if (process.platform === "win32" && typeof proc.pid === "number") {
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // fall through to SIGKILL
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }
}

export async function spawnChrome(input: SpawnChromeInput): Promise<RunningChrome> {
  await mkdir(input.userDataDir, { recursive: true });

  const proc = spawn(input.executablePath, [...input.args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Drain stdio so the kernel pipe buffer never fills up — Chrome prints
  // plenty to stderr (GPU process warnings, font loader chatter) and a
  // full pipe would stall the process after a few seconds.
  proc.stdout?.on("data", () => undefined);
  proc.stderr?.on("data", () => undefined);

  const exitPromise = new Promise<never>((_resolve, reject) => {
    proc.once("exit", (code, signal) => {
      reject(
        new Error(
          `Chrome exited before CDP became ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
    proc.once("error", (err) => {
      reject(new Error(`failed to spawn Chrome: ${err.message}`));
    });
  });

  const cdpUrl = `http://127.0.0.1:${input.cdpPort}`;
  try {
    await Promise.race([
      waitForCdpReady({
        cdpUrl,
        timeoutMs: input.readinessTimeoutMs,
        pollIntervalMs: input.pollIntervalMs ?? 100,
      }),
      exitPromise,
    ]);
  } catch (err) {
    killProcessTree(proc);
    throw err;
  }

  return { proc, cdpUrl };
}

interface WaitForCdpInput {
  cdpUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

async function waitForCdpReady(input: WaitForCdpInput): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${input.cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (resp.ok) {
        // Drain body so the socket is released immediately.
        await resp.text().catch(() => "");
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await delay(input.pollIntervalMs);
  }
  const detail =
    lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new Error(
    `CDP endpoint ${input.cdpUrl}/json/version did not become ready within ${input.timeoutMs}ms${detail}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the OS for an unused TCP port bound to loopback. Used when the
 * caller did not pin an explicit `cdpPort`; we still bind through the
 * OS so we do not race with other local services.
 */
export function pickAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("failed to allocate loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Politely ask a spawned Chrome to exit. We first try SIGTERM (which
 * Chrome handles by writing `exit_type=Normal`), then fall back to
 * SIGKILL after a grace period so the caller's shutdown path cannot
 * hang forever.
 */
export async function stopChrome(
  proc: ChildProcess,
  graceMs = 3_000,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  // Windows has no graceful SIGTERM for Chrome's process tree — go straight
  // to `taskkill /T /F` so no orphaned helper processes linger.
  if (process.platform === "win32") {
    killProcessTree(proc);
    await Promise.race([exited, delay(graceMs)]);
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const timed = await Promise.race([
    exited.then(() => "exited" as const),
    delay(graceMs).then(() => "timeout" as const),
  ]);
  if (timed === "timeout") {
    killProcessTree(proc);
    await exited;
  }
}
