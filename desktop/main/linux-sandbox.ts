/**
 * ATO-1229 — an AppImage on a Linux that blocks Electron's sandbox.
 *
 * Electron on Linux sandboxes its child processes with unprivileged user
 * namespaces, or, when it cannot create one, with the setuid helper
 * `chrome-sandbox` (root-owned, mode 4755). Ubuntu 23.10+ restricts
 * unprivileged user namespaces through AppArmor
 * (kernel.apparmor_restrict_unprivileged_userns=1): only a program with an
 * AppArmor profile that allows `userns` may use them.
 *
 * - The .deb installs such a profile and, when it cannot load it, makes
 *   chrome-sandbox the setuid helper (build/linux/after-install.tpl).
 * - An AppImage can do neither: its path is wherever the person saved it, so
 *   no profile names it, and its files are mounted nosuid. electron-builder's
 *   AppRun therefore adds --no-sandbox before it starts the app when
 *   `unshare -Ur true` fails.
 *
 * This is the same decision taken again inside the app, for a start that
 * skipped AppRun's probe (no `unshare` on the system, the binary started
 * from the mounted folder): an AppImage on a system that blocks
 * unprivileged user namespaces, with no working setuid helper, runs with
 * `--no-sandbox`, and says so once in the log. Chromium sets its sandbox up
 * very early, so the switch is appended at the top of main.ts, before the
 * app is ready (the only time Electron reads it); it is a second line behind
 * AppRun, not a replacement for it. A .deb, macOS and Windows are never
 * touched, and nothing changes where namespaces work.
 *
 * `sandboxVerdict` is pure (the /proc reads and the stat are handed in);
 * `probeLinuxSandbox` does the reads.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SandboxFacts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  /** /proc/sys/kernel/apparmor_restrict_unprivileged_userns, or null when the file is not there. */
  restrictUserns: string | null;
  /** /proc/sys/kernel/unprivileged_userns_clone (older Debian kernels), or null. */
  usernsClone: string | null;
  /** /proc/sys/user/max_user_namespaces, or null. */
  maxUserNamespaces: string | null;
  /** Owner and mode of the chrome-sandbox next to the executable, or null when there is none. */
  chromeSandbox: { uid: number; mode: number } | null;
}

export type SandboxVerdict = { noSandbox: false } | { noSandbox: true; reason: string };

const SETUID = 0o4000;

/** A chrome-sandbox Chromium can use: owned by root and setuid. */
export function setuidHelperReady(stat: { uid: number; mode: number } | null): boolean {
  return stat != null && stat.uid === 0 && (stat.mode & SETUID) !== 0;
}

/** Why unprivileged user namespaces are not available here, or null when nothing says they are blocked. */
export function usernsBlockedReason(facts: Pick<SandboxFacts, "restrictUserns" | "usernsClone" | "maxUserNamespaces">): string | null {
  if (facts.restrictUserns?.trim() === "1") return "kernel.apparmor_restrict_unprivileged_userns=1";
  if (facts.usernsClone?.trim() === "0") return "kernel.unprivileged_userns_clone=0";
  if (facts.maxUserNamespaces?.trim() === "0") return "user.max_user_namespaces=0";
  return null;
}

export function sandboxVerdict(facts: SandboxFacts): SandboxVerdict {
  if (facts.platform !== "linux") return { noSandbox: false };
  const appImage = typeof facts.env.APPIMAGE === "string" && facts.env.APPIMAGE.trim().length > 0;
  if (!appImage) return { noSandbox: false };
  if (facts.argv.includes("--no-sandbox")) return { noSandbox: false };
  const blocked = usernsBlockedReason(facts);
  if (!blocked) return { noSandbox: false };
  if (setuidHelperReady(facts.chromeSandbox)) return { noSandbox: false };
  return { noSandbox: true, reason: `${blocked} and no setuid chrome-sandbox` };
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The facts of this process. Only ever reads; never throws. */
export function probeLinuxSandbox(execPath: string = process.execPath): SandboxFacts {
  let chromeSandbox: SandboxFacts["chromeSandbox"] = null;
  if (process.platform === "linux") {
    try {
      const st = statSync(join(dirname(execPath), "chrome-sandbox"));
      chromeSandbox = { uid: st.uid, mode: st.mode };
    } catch {
      chromeSandbox = null;
    }
  }
  const linux = process.platform === "linux";
  return {
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    restrictUserns: linux ? readProc("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") : null,
    usernsClone: linux ? readProc("/proc/sys/kernel/unprivileged_userns_clone") : null,
    maxUserNamespaces: linux ? readProc("/proc/sys/user/max_user_namespaces") : null,
    chromeSandbox,
  };
}
