import { existsSync } from "node:fs";

import { activateApp as activateMacApp, readFrontApp as readMacFrontApp, run } from "./keystroke-clipboard-host.js";
import {
  appNameFromTitle,
  linuxFrontPlan,
  onPath,
  parseWinFront,
  parseXid,
  winActivateCommand,
  winFrontCommand,
  X11_ACTIVE_WINDOW,
  x11ActivateCommand,
  x11NameCommand,
  x11PidCommand,
} from "./replace-front-app.js";
import type { SourceApp } from "./replace-selection.js";

/**
 * ATO-2738, the Electron side of replace-front-app.ts: the app (macOS) or
 * window (Windows, Linux) in front when the hotkey read the selection, and
 * bringing it back before the paste. macOS is keystroke-clipboard-host.ts's
 * as it was (ATO-2268). Never throws.
 */

const env = () => ({ platform: process.platform, env: process.env });
const has = (tool: string) => onPath(tool, process.env, existsSync);

async function readX11(): Promise<SourceApp | null> {
  const active = await run(X11_ACTIVE_WINDOW, 1500);
  const xid = active.ran ? parseXid(active.stdout) : null;
  const nameCmd = xid ? x11NameCommand(xid) : null;
  const pidCmd = xid ? x11PidCommand(xid) : null;
  if (!xid || !nameCmd || !pidCmd) return null;
  const [name, pid] = await Promise.all([run(nameCmd, 1500), run(pidCmd, 1500)]);
  const owner = pid.ran ? Number.parseInt(pid.stdout.trim(), 10) : NaN;
  // The hotkey pressed over our own window: nothing to put back into.
  if (owner === process.pid) return null;
  return { name: (name.ran && appNameFromTitle(name.stdout)) || "the app", pid: Number.isInteger(owner) && owner > 0 ? owner : 0, xid };
}

/** The app or window in front, for "Replace in …"; null when it cannot be read. */
export async function readFrontApp(): Promise<SourceApp | null> {
  try {
    if (process.platform === "darwin") return await readMacFrontApp();
    if (process.platform === "win32") {
      // PowerShell compiles its user32 lines first: a cold start takes a second or two.
      const out = await run(winFrontCommand(), 5000);
      return out.ran ? parseWinFront(out.stdout, process.pid) : null;
    }
    if (process.platform === "linux") return linuxFrontPlan(env(), has) ?? (await readX11());
    return null;
  } catch {
    return null;
  }
}

/** Brings it back to the front; false when it is gone or would not come (nothing is pasted then). */
export async function activateApp(target: SourceApp): Promise<boolean> {
  try {
    if (process.platform === "darwin") return await activateMacApp(target);
    if (process.platform === "win32") {
      const cmd = target.hwnd ? winActivateCommand(target.hwnd) : null;
      if (!cmd) return false;
      const out = await run(cmd, 5000);
      return out.ran && out.stdout.trim() === "ok";
    }
    if (process.platform === "linux") {
      // Wayland: closing the mini chat already gave the keyboard back to the window under it.
      if (target.wayland) return true;
      const cmd = target.xid ? x11ActivateCommand(target.xid) : null;
      if (!cmd) return false;
      return (await run(cmd, 2000)).ran;
    }
    return false;
  } catch {
    return false;
  }
}
