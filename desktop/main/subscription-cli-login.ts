import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubscriptionCli } from "./subscription-cli-detect.js";

/**
 * ATO-845: "Sign in with Claude" / "Sign in with ChatGPT" opens the system
 * terminal with the CLI's sign-in already running, so a person who has never
 * used a terminal only has to finish in the browser. The wizard then polls
 * `cli:subscriptionStatus` and moves on by itself.
 *
 * Only two fixed commands are ever run, and only on a click: `codex login`
 * and `claude` (Claude Code asks to sign in on its first run, and /login
 * otherwise). The binary may be the absolute path the detector found off
 * PATH; anything that does not look like a plain path falls back to the bare
 * name, so nothing a file on disk says can reach a shell as code.
 *
 * macOS: a `.command` file opened with `open -a Terminal`, not AppleScript.
 * `tell application "Terminal"` needs the Automation permission (and the
 * apple-events entitlement under the hardened runtime), which the app does
 * not ask for; opening a file needs nothing. Terminal types it into the
 * person's own login shell, so their PATH is the one `claude` was found on.
 */

export type TerminalName = "terminal_app" | "cmd" | "x-terminal-emulator" | "gnome-terminal" | "konsole" | "xfce4-terminal" | "xterm";

export interface LoginTerminalResult {
  ok: boolean;
  /** Which terminal was asked to open, for the analytics event. */
  terminal?: TerminalName;
  /** Why it did not open: no terminal found, or the launcher failed. */
  reason?: "no_terminal" | "launch_failed" | "unsupported_platform";
}

/** One program to try and its argv. */
export interface TerminalLaunch {
  terminal: TerminalName;
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Wait for the launcher to exit 0 (`open` returns at once) rather than just start. */
  waitForExit?: boolean;
}

export interface LoginDeps {
  platform: NodeJS.Platform;
  /** Resolves true once the launcher process started, false on ENOENT and other spawn errors. */
  launch: (l: TerminalLaunch) => Promise<boolean>;
  /** Writes the macOS `.command` file and returns its path. */
  writeScript: (name: string, text: string) => string;
}

const SAFE_PATH = /^[A-Za-z0-9_./\\: ()-]+$/;

/** The binary to run: the detector's off-PATH path when it is a plain path, else the bare name. */
export function loginBinary(cli: SubscriptionCli, binPath: string | null | undefined): string {
  if (binPath && SAFE_PATH.test(binPath) && !binPath.includes("..")) return binPath;
  return cli;
}

/** The sign-in command line, as a POSIX shell or cmd.exe would read it. */
export function loginCommandLine(cli: SubscriptionCli, binPath: string | null | undefined, platform: NodeJS.Platform): string {
  const bin = loginBinary(cli, binPath);
  const quoted = bin === cli ? bin : platform === "win32" ? `"${bin}"` : `'${bin}'`;
  return cli === "codex" ? `${quoted} login` : quoted;
}

/** What the macOS `.command` file says: a line on what is happening, then the sign-in. */
export function macLoginScript(cli: SubscriptionCli, binPath: string | null | undefined): string {
  const product = cli === "codex" ? "Codex (your ChatGPT plan)" : "Claude Code (your Claude plan)";
  const after = cli === "claude" ? " If it does not ask you to sign in, type /login and press Return." : "";
  return [
    "#!/bin/sh",
    "clear",
    `echo "Atomic Agent: signing in to ${product}. Finish in the browser window that opens.${after}"`,
    "echo",
    loginCommandLine(cli, binPath, "darwin"),
    "",
  ].join("\n");
}

/** The launchers to try, in order, for this platform. */
export function terminalLaunches(
  cli: SubscriptionCli,
  binPath: string | null | undefined,
  platform: NodeJS.Platform,
  macScriptPath?: string,
): TerminalLaunch[] {
  const line = loginCommandLine(cli, binPath, platform);
  if (platform === "darwin") {
    if (!macScriptPath) return [];
    return [{ terminal: "terminal_app", command: "/usr/bin/open", args: ["-a", "Terminal", macScriptPath], waitForExit: true }];
  }
  if (platform === "win32") {
    // `start` opens a new console window; `/k` keeps it open after the
    // command, so the person can read what it said.
    return [{
      terminal: "cmd",
      command: "cmd.exe",
      args: ["/d", "/c", `start "Sign in" cmd.exe /k ${line}`],
      windowsVerbatimArguments: true,
    }];
  }
  if (platform === "linux") {
    // The shell stays open after the command so its last words stay readable.
    const keep = `${line}; exec "\${SHELL:-sh}"`;
    return [
      { terminal: "x-terminal-emulator", command: "x-terminal-emulator", args: ["-e", "sh", "-c", keep] },
      { terminal: "gnome-terminal", command: "gnome-terminal", args: ["--", "sh", "-c", keep] },
      { terminal: "konsole", command: "konsole", args: ["-e", "sh", "-c", keep] },
      { terminal: "xfce4-terminal", command: "xfce4-terminal", args: ["-x", "sh", "-c", keep] },
      { terminal: "xterm", command: "xterm", args: ["-e", "sh", "-c", keep] },
    ];
  }
  return [];
}

function defaultWriteScript(name: string, text: string): string {
  // $TMPDIR on macOS is the person's own folder, not shared /tmp.
  const path = join(tmpdir(), name);
  writeFileSync(path, text, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function defaultLaunch(l: TerminalLaunch): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(l.command, l.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        ...(l.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    if (l.waitForExit) child.once("exit", (code) => resolve(code === 0));
    else child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

/** Open the system terminal with the sign-in running. Tries each launcher until one starts. */
export async function openLoginTerminal(
  cli: SubscriptionCli,
  binPath: string | null | undefined,
  deps: Partial<LoginDeps> = {},
): Promise<LoginTerminalResult> {
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? defaultLaunch;
  let macScript: string | undefined;
  if (platform === "darwin") {
    try {
      macScript = (deps.writeScript ?? defaultWriteScript)(`atomic-agent-sign-in-${cli}.command`, macLoginScript(cli, binPath));
    } catch {
      return { ok: false, reason: "launch_failed" };
    }
  }
  const launches = terminalLaunches(cli, binPath, platform, macScript);
  if (launches.length === 0) return { ok: false, reason: "unsupported_platform" };
  for (const l of launches) {
    if (await launch(l)) return { ok: true, terminal: l.terminal };
  }
  return { ok: false, reason: platform === "linux" ? "no_terminal" : "launch_failed" };
}
