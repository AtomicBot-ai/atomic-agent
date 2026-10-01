/**
 * Platform decisions, as pure functions.
 *
 * Everything here takes the platform (and any paths it needs) as an
 * argument instead of reading `process.platform`, so the unit suite can
 * drive the Windows and Linux arms from a Mac. No Electron import: this
 * module is loaded by `node --test` straight from `out/main`.
 *
 * The macOS arm of every function returns exactly what the code it
 * replaced used to compute. Changing a mac answer here is a behaviour
 * change for the shipped app, not a refactor.
 */

import { posix, win32 } from "node:path";

export type Platform = NodeJS.Platform;

/** The path module that matches `platform`'s path rules. */
export function pathFor(platform: Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/* ------------------------------------------------------ agent binary --- */

/** The agent's file name inside the packaged app's `agent/` folder. */
export function bundledAgentFileName(platform: Platform): string {
  return platform === "win32" ? "atomic-agent.exe" : "atomic-agent";
}

export interface CandidateInputs {
  platform: Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** `process.resourcesPath`, or undefined outside a packaged app. */
  resourcesPath?: string;
}

/**
 * Where the agent might be, most preferred first.
 *
 * macOS (unchanged): the override, the bundled agent, a developer checkout
 * at ~/atag-agent/bin/atag, then the released install (install.sh puts it
 * in ~/.local/bin) and the two usual system prefixes.
 *
 * Windows: only real executables. `atag.cmd` is a batch shim, and Node
 * refuses to `execFile`/`spawn` a .cmd without a shell, so it is never a
 * candidate; the `atomic-agent.exe` it points at is. install.ps1 installs
 * into %ATOMIC_AGENT_INSTALL_DIR% or %LOCALAPPDATA%\atomic-agent; install.sh
 * under Git Bash / MSYS puts `atomic-agent.exe` in ~/.local/bin.
 *
 * Linux: the same shape as macOS, with Linuxbrew's prefix in place of
 * Homebrew's.
 */
export function agentBinaryCandidates(input: CandidateInputs): string[] {
  const { platform, home, env, resourcesPath } = input;
  const p = pathFor(platform);
  const fromEnv = env["ATOMIC_AGENT_BIN"];
  const bundled = resourcesPath ? p.join(resourcesPath, "agent", bundledAgentFileName(platform)) : null;
  const head = [...(fromEnv ? [fromEnv] : []), ...(bundled ? [bundled] : [])];

  if (platform === "win32") {
    const installDir = env["ATOMIC_AGENT_INSTALL_DIR"];
    const localAppData = env["LOCALAPPDATA"] || p.join(home, "AppData", "Local");
    return [
      ...head,
      ...(installDir ? [p.join(installDir, "atomic-agent.exe")] : []),
      p.join(localAppData, "atomic-agent", "atomic-agent.exe"),
      p.join(home, ".local", "bin", "atomic-agent.exe"),
      p.join(home, "atag-agent", "bin", "atomic-agent.exe"),
    ];
  }

  const tail = platform === "darwin"
    ? ["/usr/local/bin/atag", "/opt/homebrew/bin/atag"]
    : ["/usr/local/bin/atag", "/home/linuxbrew/.linuxbrew/bin/atag"];
  return [
    ...head,
    p.join(home, "atag-agent", "bin", "atag"),
    p.join(home, ".local", "bin", "atag"),
    p.join(home, ".local", "bin", "atomic-agent"),
    ...tail,
  ];
}

/** The one-line install hint shown when no agent is found. */
export function installHint(platform: Platform): string {
  return platform === "win32"
    ? "No atomic-agent binary found. Install it with `irm https://atomicagent.io/install.ps1 | iex` in PowerShell, or set ATOMIC_AGENT_BIN."
    : "No atomic-agent binary found. Install it with `curl -fsSL https://atomicagent.io/install | sh`, or set ATOMIC_AGENT_BIN.";
}

/* ------------------------------------------------------ stopping it --- */

/**
 * How to end a supervised child.
 *
 * POSIX: SIGTERM, which lets `atag serve` close its sqlite handles and stop
 * its own children, then SIGKILL if it is still there after the grace.
 *
 * Windows has no signals. `child.kill("SIGTERM")` there is TerminateProcess
 * on the one pid, which leaves anything the agent started (MCP servers,
 * shell tools) running without a parent. `taskkill /T /F` ends the whole
 * tree. There is no gentler request a windowless console child can be
 * sent from another console, so the forced tree kill IS the stop; sqlite
 * in WAL mode is built to survive exactly that.
 */
export type StopPlan =
  | { kind: "signals"; first: "SIGTERM"; then: "SIGKILL" }
  | { kind: "taskkill"; command: string; args: string[] };

export function stopPlan(platform: Platform, pid: number, systemRoot?: string): StopPlan {
  if (platform === "win32") {
    return { kind: "taskkill", command: taskkillPath(systemRoot), args: ["/PID", String(pid), "/T", "/F"] };
  }
  return { kind: "signals", first: "SIGTERM", then: "SIGKILL" };
}

/** taskkill by absolute path, so a stray `taskkill` earlier on PATH is never run. */
export function taskkillPath(systemRoot?: string): string {
  return win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/* ------------------------------------------------ orphan recognition --- */

/**
 * How to read a live pid's command line on this platform.
 *   darwin — `/bin/ps -o command= -p <pid>` (unchanged).
 *   linux  — `/proc/<pid>/cmdline`, NUL-separated; no dependency on a `ps`
 *            that minimal distributions do not ship.
 *   win32  — PowerShell's CIM query; `wmic` is gone from current Windows.
 */
export type CommandLineProbe =
  | { kind: "exec"; command: string; args: string[] }
  | { kind: "procfs"; file: string };

export function commandLineProbe(platform: Platform, pid: number, systemRoot?: string): CommandLineProbe {
  if (platform === "linux") return { kind: "procfs", file: `/proc/${pid}/cmdline` };
  if (platform === "win32") {
    return {
      kind: "exec",
      command: win32.join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`,
      ],
    };
  }
  return { kind: "exec", command: "/bin/ps", args: ["-o", "command=", "-p", String(pid)] };
}

/** `/proc/<pid>/cmdline` is argv joined by NULs; make it read like `ps`. */
export function procCmdline(raw: string): string {
  return raw.split("\0").filter((s) => s.length > 0).join(" ");
}

/**
 * True when a command line is an `atag serve` bound to `port`.
 *
 * The binary may be named after `/`, `\` (Windows), a space, or an opening
 * quote (Windows quotes a path with spaces): `"C:\...\atomic-agent.exe" serve`.
 */
export function looksLikeServeCommand(cmd: string, port: number): boolean {
  return /(^|[/\\\s"])(atag|atomic-agent|index\.js)\b/.test(cmd)
    && /\bserve\b/.test(cmd)
    && cmd.includes(`--port ${port}`);
}

/* ----------------------------------------------------------- paths --- */

/** Absolute by the platform's own rules (`C:\x`, `\\server\share` on Windows). */
export function isAbsoluteOn(platform: Platform, p: string): boolean {
  return pathFor(platform).isAbsolute(p);
}

/** `p` without trailing separators, never reduced to an empty string. */
export function trimTrailingSep(platform: Platform, p: string): string {
  const re = platform === "win32" ? /[\\/]+$/ : /\/+$/;
  const trimmed = p.replace(re, "");
  if (!trimmed) return p;
  // `C:\` must stay a root, not become the drive-relative `C:`.
  if (platform === "win32" && /^[A-Za-z]:$/.test(trimmed)) return trimmed + "\\";
  return trimmed;
}

/**
 * Is `p` the directory `root`, or inside it? String containment on the
 * platform's separators. Windows paths compare case-insensitively.
 */
export function isUnder(platform: Platform, root: string, p: string): boolean {
  if (!isAbsoluteOn(platform, p)) return false;
  if (platform !== "win32") return p === root || p.startsWith(root + "/");
  const a = p.replace(/\//g, "\\").toLowerCase();
  const r = root.replace(/\//g, "\\").toLowerCase();
  return a === r || a.startsWith(r.endsWith("\\") ? r : r + "\\");
}

/** The last segment of a path — a folder's own name for a notification. */
export function lastSegment(platform: Platform, p: string): string | undefined {
  const re = platform === "win32" ? /[\\/]/ : /\//;
  return p.split(re).filter(Boolean).pop();
}

/** A leading `~` expanded against `home`, on this platform's separators. */
export function expandHome(platform: Platform, p: string, home: string): string {
  if (p.startsWith("~/")) return home + p.slice(1);
  if (platform === "win32" && p.startsWith("~\\")) return home + p.slice(1);
  return p;
}

/* ------------------------------------------------------- the window --- */

/**
 * The BrowserWindow chrome options that differ by platform.
 *
 * macOS (unchanged): the design's own 52px toolbar under inset traffic
 * lights, with the sidebar vibrancy.
 *
 * Windows: the same frameless toolbar, with the system's minimise /
 * maximise / close drawn over its right end by `titleBarOverlay`. The
 * overlay is exactly the toolbar's height so the buttons sit in that band.
 *
 * Linux: a normal frame. Window-controls-overlay support varies by window
 * manager and compositor there, and a window that cannot be closed is the
 * one failure worth avoiding at any cost. The menu bar auto-hides (Alt
 * shows it) so the frame adds only the title bar.
 */
export interface ChromeOptions {
  titleBarStyle?: "hiddenInset" | "hidden";
  trafficLightPosition?: { x: number; y: number };
  vibrancy?: "sidebar";
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  autoHideMenuBar?: boolean;
}

export const TOOLBAR_HEIGHT = 52;

/** Overlay colours per theme: the toolbar's --well and --ink (styles.css --i-* / --p-*). */
export function titleBarOverlayColors(dark: boolean): { color: string; symbolColor: string } {
  return dark
    ? { color: "#0B0C0D", symbolColor: "#EDEFF1" }
    : { color: "#F1F2F4", symbolColor: "#101112" };
}

export function windowChrome(platform: Platform): ChromeOptions {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 20 }, vibrancy: "sidebar" };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { ...titleBarOverlayColors(true), height: TOOLBAR_HEIGHT },
    };
  }
  return { autoHideMenuBar: true };
}

/* ------------------------------------------------------------ voice --- */

/** The speech helper is Apple's on-device SpeechAnalyzer; macOS only. */
export function voiceSupported(platform: Platform): boolean {
  return platform === "darwin";
}

/** The file manager's name, for "Show in …". */
export function fileManagerLabel(platform: Platform): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in Folder";
}
