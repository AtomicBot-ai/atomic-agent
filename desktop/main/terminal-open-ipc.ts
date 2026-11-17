/**
 * ATO-1424 — the `terminal:openWithCommand` route (terminal-open.ts does the
 * work and says why it is built this way).
 *
 *   terminal:openWithCommand({ command, cwd })
 *     → { ok: true, cwd, usedHome } | { ok: false, error, message }
 *
 * macOS only; elsewhere the answer is { ok: false, error: "unsupported" }.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, ipcMain } from "electron";

import { SWEEP_AT_START_MS, openTerminalWithCommand, sweepLaunchDirs } from "./terminal-open.js";

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

export function wireTerminalOpenIpc(): void {
  // Launch folders a past run never got to delete.
  if (process.platform === "darwin") sweepLaunchDirs(terminalRoot(), SWEEP_AT_START_MS);

  ipcMain.handle("terminal:openWithCommand", (_event, payload: unknown) =>
    openTerminalWithCommand(payload, {
      platform: process.platform,
      home: homedir(),
      root: terminalRoot(),
      execFile: execFileArgs,
    }),
  );
}
