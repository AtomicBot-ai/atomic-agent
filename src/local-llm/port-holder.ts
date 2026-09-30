import { execFile } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveVersionFilePath } from "./backend-paths.js";

/**
 * Who is listening on a managed port, read off the OS rather than off
 * our own pid files — the case this exists for is a llama-server that
 * no pid file of ours names (another state dir's daemon, a crashed
 * launch's survivor, somebody else's server).
 *
 * Every probe is best-effort: a missing tool, a timeout or a process we
 * may not inspect reads as "unknown", and the caller treats unknown as
 * "not ours to touch".
 */

export interface PortHolder {
  pid: number;
  /** Absolute path of the holder's executable, `null` when unreadable. */
  executable: string | null;
  /**
   * The atomic-agent local-models data dir the holder was launched from
   * (`<dataDir>/backend/llama-server`), or `null` when it is not an
   * atomic-agent managed llama-server.
   */
  atagDataDir: string | null;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string } | null>;

/** `execFile` with a short deadline; `null` when the tool is missing or hung. */
export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          resolve(null);
          return;
        }
        resolve({
          code: err ? Number((err as { code: number }).code) : 0,
          stdout: String(stdout),
        });
      },
    );
  });

export interface PortHolderDeps {
  run?: RunCommand;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  readlink?: (path: string) => string;
}

export async function findPortHolder(
  port: number,
  deps: PortHolderDeps = {},
): Promise<PortHolder | null> {
  const run = deps.run ?? runCommand;
  const platform = deps.platform ?? process.platform;
  const pid = await findListeningPid(port, run, platform);
  if (pid === null) return null;
  const executable = await readExecutablePath(pid, run, platform, deps.readlink);
  return {
    pid,
    executable,
    atagDataDir: executable ? atagDataDirOf(executable, deps.exists) : null,
  };
}

async function findListeningPid(
  port: number,
  run: RunCommand,
  platform: NodeJS.Platform,
): Promise<number | null> {
  if (platform === "win32") {
    const out = await run("netstat", ["-ano", "-p", "TCP"]);
    return out ? parseNetstatListeningPid(out.stdout, port) : null;
  }
  const lsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsof && lsof.code === 0) {
    const pids = parseLsofPids(lsof.stdout);
    if (pids.length > 0) return pids[0]!;
  }
  if (platform === "linux") {
    const ss = await run("ss", ["-ltnpH", `sport = :${port}`]);
    return ss ? parseSsPid(ss.stdout) : null;
  }
  return null;
}

async function readExecutablePath(
  pid: number,
  run: RunCommand,
  platform: NodeJS.Platform,
  readlink: ((path: string) => string) | undefined,
): Promise<string | null> {
  if (platform === "linux") {
    try {
      return (readlink ?? readlinkSync)(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  if (platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
    ]);
    const path = out?.stdout.trim();
    return path ? path : null;
  }
  // macOS: `comm` is the full executable path, spaces and all.
  const out = await run("ps", ["-o", "comm=", "-p", String(pid)]);
  const path = out?.code === 0 ? out.stdout.trim() : "";
  return path ? path : null;
}

/** `lsof -t` prints one pid per line. */
export function parseLsofPids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** `netstat -ano` row: `TCP  127.0.0.1:19091  0.0.0.0:0  LISTENING  4242`. */
export function parseNetstatListeningPid(stdout: string, port: number): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]!.toUpperCase() !== "TCP") continue;
    if (!cols[1]!.endsWith(`:${port}`) || cols[3]!.toUpperCase() !== "LISTENING") continue;
    const pid = Number.parseInt(cols[4]!, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

/** `ss -ltnpH`: `... users:(("llama-server",pid=4242,fd=3))`. */
export function parseSsPid(stdout: string): number | null {
  const m = /pid=(\d+)/.exec(stdout);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * `<dataDir>/backend/llama-server[.exe]` with the backend's version
 * file beside it — the shape `resolveServerBinPath` installs. Anything
 * else (Atomic Chat's, Ollama's, a hand-built server) is not ours.
 */
export function atagDataDirOf(
  executable: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const name = basename(executable).toLowerCase();
  if (name !== "llama-server" && name !== "llama-server.exe") return null;
  const backendDir = dirname(executable);
  if (basename(backendDir) !== "backend") return null;
  const dataDir = dirname(backendDir);
  return exists(resolveVersionFilePath(dataDir)) ? dataDir : null;
}

/**
 * Whether anything of that state dir is still running: an atomic-agent
 * process (TUI, `serve`, the desktop sidecar) keeps `sessions.sqlite`
 * open for its whole life. `true` when unknown — no lsof, Windows, a
 * relocated data dir — because a wrong "abandoned" kills a live model.
 */
export async function isStateDirInUse(
  atagDataDir: string,
  deps: PortHolderDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return true;
  const db = join(dirname(atagDataDir), "sessions.sqlite");
  if (!(deps.exists ?? existsSync)(db)) return true;
  const out = await (deps.run ?? runCommand)("lsof", ["-t", "--", db]);
  if (out === null) return true;
  // lsof exits 1 with no output when nobody has the file open.
  if (out.code === 1 && out.stdout.trim() === "") return false;
  return out.code !== 0 || parseLsofPids(out.stdout).length > 0;
}
