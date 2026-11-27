/**
 * ATO-2172: the `atag serve` a launched coding CLI talks to.
 *
 * Reuse first: a serve on record (`<stateDir>/serve/<pid>.json`, see
 * serve-reaper.ts) whose process is alive, whose `GET /health` names that
 * same pid, which listens on this machine and works in the same folder.
 * The folder matters because the agent behind `/v1` runs its tools in the
 * serve's working directory, and Claude Code, Codex and OpenCode do not
 * send one.
 *
 * Otherwise a new serve is started in the background on a free loopback
 * port with `--cwd <folder>`. It is NOT started with `--no-parent-exit`:
 * its parent is the `atag launch` process, which lives exactly as long as
 * the CLI, so the serve's orphan guard stops it when the CLI exits. It
 * gets its own process group (`detached`), so a Ctrl+C meant for the CLI
 * does not reach it.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import { readServeRecords, type ServeRecord } from "./serve-reaper.js";
import { isAlive } from "./serve-orphan-guard.js";

export interface LaunchServe {
  readonly baseUrl: string;
  readonly port: number;
  /** Whether this run started it (and it stops when the CLI exits). */
  readonly started: boolean;
}

interface HealthBody {
  readonly runtime?: string;
  readonly pid?: number;
  readonly workingDir?: string;
}

export interface LaunchServeDeps {
  readonly fetch?: typeof fetch;
  readonly isAlive?: (pid: number) => boolean;
  readonly records?: (stateDir: string) => readonly ServeRecord[];
  readonly spawn?: typeof nodeSpawn;
  readonly freePort?: () => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long a started serve may take to answer `/health`. */
  readonly readyTimeoutMs?: number;
}

/** The port `atag serve` listens on without `--port` (serve-args.ts). */
export const DEFAULT_SERVE_PORT = 8787;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"]);
const PROBE_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 90_000;

export function loopbackBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** `/health` without the llama probe; null when nothing answered in time. */
export async function readServeHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthBody | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/health?llama=0`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthBody;
  } catch {
    return null;
  }
}

/**
 * A live serve on this machine working in `cwd`, or null. `cwd` null
 * (ATO-2447, the bare local model) takes a serve in any folder: the
 * `/local/v1` routes run no agent tools, so the folder does not matter.
 */
export async function findReusableServe(
  stateDir: string,
  cwd: string | null,
  deps: LaunchServeDeps = {},
): Promise<LaunchServe | null> {
  const alive = deps.isAlive ?? isAlive;
  const records = (deps.records ?? ((dir) => readServeRecords(dir).map((r) => r.record)))(stateDir);
  const folder = cwd === null ? null : resolve(cwd);
  for (const record of records) {
    if (!LOOPBACK_HOSTS.has(record.host) || !alive(record.pid)) continue;
    const baseUrl = loopbackBaseUrl(record.port);
    const health = await readServeHealth(baseUrl, deps.fetch);
    if (health?.runtime !== "atomic-agent" || health.pid !== record.pid) continue;
    if (folder !== null && (typeof health.workingDir !== "string" || resolve(health.workingDir) !== folder)) continue;
    return { baseUrl, port: record.port, started: false };
  }
  return null;
}

/** A port nothing listens on right now, from the OS. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
    });
  });
}

/** Start `serve --port <p> --cwd <cwd>` in the background and wait until it answers. */
export async function startLaunchServe(
  stateDir: string,
  cwd: string,
  deps: LaunchServeDeps = {},
): Promise<LaunchServe | { readonly error: string }> {
  const port = await (deps.freePort ?? pickFreePort)();
  const logDir = join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `launch-serve-${port}.log`);
  const self = selfInvocation({
    execPath: process.execPath,
    argv: process.argv,
    execArgv: process.execArgv,
    isSea: isSeaBuild(),
  });
  const logFd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(
      self.cmd,
      [
        ...self.args,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--cwd",
        resolve(cwd),
        // Claude Code, Codex and OpenCode never see an approval prompt.
        "--refuse-approvals",
      ],
      {
        cwd: resolve(cwd),
        stdio: ["ignore", logFd, logFd],
        detached: true,
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
        env: { ...process.env },
      },
    );
  } finally {
    closeSync(logFd);
  }
  let exited = false;
  child.on("error", () => { exited = true; });
  child.on("exit", () => { exited = true; });
  child.unref();
  if (child.pid == null) return { error: `could not start atag serve (log: ${logPath})` };

  const baseUrl = loopbackBaseUrl(port);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (exited) return { error: `atag serve stopped while starting (log: ${logPath})` };
    const health = await readServeHealth(baseUrl, deps.fetch);
    if (health?.runtime === "atomic-agent" && health.pid === child.pid) {
      return { baseUrl, port, started: true };
    }
    await sleep(300);
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  return { error: `atag serve did not answer on port ${port} in time (log: ${logPath})` };
}

/**
 * Whether serve accepts `token`. A reused serve may run with a key given on
 * its command line, which this process cannot know; better to say so now
 * than to let the CLI fail on its first request.
 */
export async function serveAcceptsKey(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return false;
  }
}
