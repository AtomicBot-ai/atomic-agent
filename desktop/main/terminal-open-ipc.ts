/**
 * ATO-1424 — the `terminal:openWithCommand` route (terminal-open.ts does the
 * work and says why it is built this way).
 *
 *   terminal:openWithCommand({ command, cwd })
 *     → { ok: true, cwd, usedHome, terminal?, hint? } | { ok: false, error, message }
 *
 * macOS: terminal-open.ts. Windows and Linux (ATO-1430): terminal-open-other.ts,
 * with the hint for the app window. Elsewhere { ok: false, error: "unsupported" }.
 */

import { execFile, spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, clipboard, ipcMain } from "electron";

import { SWEEP_AT_START_MS, openTerminalWithCommand, sweepLaunchDirs } from "./terminal-open.js";
import { openOtherTerminalWithCommand } from "./terminal-open-other.js";
import { makeWhich } from "./terminal-pick.js";
import type { TerminalChoice } from "./terminal-pick.js";

const OPEN_TIMEOUT_MS = 15_000;

function terminalRoot(): string {
  return join(app.getPath("temp"), "atomic-agent-terminal");
}

function execFileArgs(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });
}

/** A file on PATH. Windows Terminal's wt.exe is an app execution alias that stat can refuse, so lstat counts too. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    try {
      lstatSync(p);
      return process.platform === "win32";
    } catch {
      return false;
    }
  }
}

/** Start the terminal on its own (args array, no shell); true once it started. */
function spawnTerminal(choice: TerminalChoice, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(choice.file, choice.args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

export function wireTerminalOpenIpc(): void {
  // Launch folders a past run never got to delete.
  if (process.platform === "darwin" || process.platform === "linux") sweepLaunchDirs(terminalRoot(), SWEEP_AT_START_MS);

  ipcMain.handle("terminal:openWithCommand", (_event, payload: unknown) => {
    if (process.platform === "win32" || process.platform === "linux") {
      return openOtherTerminalWithCommand(payload, {
        platform: process.platform,
        home: homedir(),
        root: terminalRoot(),
        which: makeWhich({ platform: process.platform, path: process.env.PATH ?? process.env.Path, pathExt: process.env.PATHEXT, isFile }),
        spawn: spawnTerminal,
        writeClipboard: (text) => clipboard.writeText(text),
        shell: process.env.SHELL ?? null,
      });
    }
    return openTerminalWithCommand(payload, {
      platform: process.platform,
      home: homedir(),
      root: terminalRoot(),
      execFile: execFileArgs,
    });
  });
}
