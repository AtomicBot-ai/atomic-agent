import { appendFileSync, unlinkSync } from "node:fs";

import { readExecutablePath, runCommand, type RunCommand } from "./port-holder.js";

/**
 * Whether a recorded pid may still be signalled as our model server
 * (ATO-2766).
 *
 * `llama-server.pid` / `llama-embed.pid` outlive a reboot or an engine
 * crash, and Windows hands a freed pid to a new process within seconds.
 * A stop that only checked "is the pid alive" could then run
 * `taskkill /T /F` on whatever got the number: the desktop window, whose
 * tree holds the agent, or `atag serve` itself (Sentry AgentExited
 * CLI-H0: exit 1, no output, mostly Windows). So before any signal the
 * pid must be neither this process nor its parent, and its image must be
 * a llama-server: the binary of the llama-server engine and the one
 * Atomic Core runs its models with (`core-backend.ts`). The desktop guards
 * its own leftover kill the same way (`killDaemonLeftovers`, matching the
 * command line against /llama-server/i).
 *
 * An image that cannot be read is "unknown". On Windows that fails
 * closed: pids are reused fast there and a wrong kill takes the app down,
 * while a server left running only costs the next start a port move. On
 * macOS and Linux the image read is direct (`ps`, `/proc`), pids wrap
 * slowly, and the stop keeps its old behaviour.
 */

export type ReadImage = (pid: number) => Promise<string | null>;

export interface EnginePidDeps {
  platform?: NodeJS.Platform;
  /** This process's pid; `process.pid` when omitted. */
  selfPid?: number;
  /** This process's parent pid; `process.ppid` when omitted. */
  parentPid?: number;
  /** The executable (path or image name) of `pid`, `null` when unreadable. */
  readImage?: ReadImage;
}

export type EnginePidVerdict =
  | { signal: true }
  | { signal: false; why: "self" | "parent" | "not-engine" | "unknown"; image: string | null };

export async function judgeEnginePid(
  pid: number,
  deps: EnginePidDeps = {},
): Promise<EnginePidVerdict> {
  if (pid === (deps.selfPid ?? process.pid)) return { signal: false, why: "self", image: null };
  if (pid === (deps.parentPid ?? process.ppid)) return { signal: false, why: "parent", image: null };
  const platform = deps.platform ?? process.platform;
  let image: string | null;
  try {
    image = await (deps.readImage ?? ((p: number) => readProcessImage(p, platform)))(pid);
  } catch {
    image = null;
  }
  if (image === null) {
    return platform === "win32" ? { signal: false, why: "unknown", image: null } : { signal: true };
  }
  return isEngineImage(image) ? { signal: true } : { signal: false, why: "not-engine", image };
}

/**
 * For the pid-file stops: `true` when `pid` must not be signalled. The
 * pid file is then stale (it names a process that is not our server), so
 * it is removed, and one line in the server log says why; the port check
 * of the next start decides the rest.
 */
export async function dropNonEnginePid(
  pid: number,
  pidPath: string,
  logPath: string,
  deps: EnginePidDeps = {},
): Promise<boolean> {
  const verdict = await judgeEnginePid(pid, deps);
  if (verdict.signal) return false;
  try {
    unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
  noteSkippedStop(logPath, pid, verdict);
  return true;
}

/** One line in the server log, as `noteReleaseTimeout` does. Best effort. */
export function noteSkippedStop(
  logPath: string,
  pid: number,
  verdict: Extract<EnginePidVerdict, { signal: false }>,
): void {
  const what =
    verdict.why === "self"
      ? "is this agent process"
      : verdict.why === "parent"
        ? "is the process that started this agent"
        : verdict.why === "unknown"
          ? "could not be identified"
          : `is ${baseName(verdict.image ?? "")}, not llama-server`;
  try {
    appendFileSync(
      logPath,
      `\n[atomic-agent] stop: recorded pid ${pid} ${what}; not signalled, pid file dropped\n`,
    );
  } catch {
    /* no note: the stop itself is unchanged */
  }
}

/**
 * A llama-server binary, by its last path segment: `llama-server`,
 * `llama-server.exe` (any case), or Linux's `llama-server (deleted)` when
 * the file was replaced by a backend update while it ran.
 */
export function isEngineImage(image: string): boolean {
  const name = baseName(image)
    .trim()
    .replace(/ \(deleted\)$/, "")
    .toLowerCase();
  return name === "llama-server" || name === "llama-server.exe";
}

function baseName(image: string): string {
  const parts = image.split(/[/\\]/);
  return parts[parts.length - 1] ?? image;
}

/**
 * The image of `pid`: on Windows `tasklist` first (it answers in well
 * under a second, where a cold PowerShell can take several), then the
 * CIM executable path; elsewhere the port holder's reader (`/proc/<pid>/exe`
 * on Linux, `ps -o comm=` on macOS).
 */
export async function readProcessImage(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
): Promise<string | null> {
  if (platform === "win32") {
    const out = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const name = out && out.code === 0 ? parseTasklistImage(out.stdout, pid) : null;
    if (name) return name;
  }
  return readExecutablePath(pid, run, platform, undefined);
}

/** `tasklist /FO CSV /NH` row: `"llama-server.exe","4242","Console","1","1,234 K"`. */
export function parseTasklistImage(stdout: string, pid: number): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1]!;
  }
  return null;
}
