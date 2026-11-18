/**
 * ATO-1157 — the `hub:scan` route for the Agents sheet (agent-hub-scan.ts
 * does the work and says why it is built this way).
 *
 *   hub:scan() → { ok: true, sessions: HubSession[], now }
 *              | { ok: false, reason: "remote" | "failed", message }
 *
 * Connected to an agent on another computer, the sessions on THIS computer
 * are not the ones that agent can continue (the same rule as handoff.ts),
 * so the scan is refused in words.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { ipcMain } from "electron";

import { scanAgentSessions, type HubFsDeps } from "./agent-hub-scan.js";

export const HUB_REMOTE_MESSAGE =
  "This app is connected to an agent on another computer. Its Claude Code and Codex sessions are listed there.";

/** Real disk, read-only: readdir, stat, and a positioned read of a byte range. */
export const nodeHubFs: HubFsDeps = {
  readdir: (dir) => readdirSync(dir),
  stat: (path) => {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
  },
  read: (path, start, length) => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, length));
      const n = readSync(fd, buf, 0, buf.length, Math.max(0, start));
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  },
};

export function wireAgentHubIpc(opts: { isRemote: () => boolean }): void {
  ipcMain.handle("hub:scan", () => {
    if (opts.isRemote()) return { ok: false, reason: "remote", message: HUB_REMOTE_MESSAGE };
    try {
      const now = Date.now();
      const sessions = scanAgentSessions({ home: homedir(), env: process.env, now, deps: nodeHubFs });
      return { ok: true, sessions, now };
    } catch (err) {
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  });
}
