/**
 * Facts about this install that every event and every error report is
 * stamped with, and the environment the desktop hands the agent it spawns.
 * No Electron import at module load: state-dir.ts (loaded first of all)
 * reaches agentAnalyticsEnv() through here, and the unit tests load this
 * under plain node.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRunMode, type RunModeConfig } from "../run-mode.js";

export type InstallChannel = "dmg" | "exe" | "appimage" | "deb";

/** darwin → dmg, win32 → exe, linux → appimage when run from one, else deb. */
export function installChannelFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): InstallChannel {
  if (platform === "darwin") return "dmg";
  if (platform === "win32") return "exe";
  return env.APPIMAGE ? "appimage" : "deb";
}

let cachedVersion: string | null = null;
/** `app.getVersion()`, read lazily; empty outside Electron. */
export function desktopVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const electron = require("electron") as { app?: { getVersion(): string } };
    cachedVersion = typeof electron?.app?.getVersion === "function" ? electron.app.getVersion() : "";
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}

/** What `agentEnv()` adds for the agent's own analytics (SPEC "Env passed by the desktop"). */
export function agentAnalyticsEnv(): Record<string, string> {
  const out: Record<string, string> = {
    ATOMIC_AGENT_SURFACE: "desktop",
    ATOMIC_AGENT_INSTALL_CHANNEL: installChannelFor(process.platform, process.env),
  };
  const v = desktopVersion();
  if (v) out.ATOMIC_AGENT_DESKTOP_VERSION = v;
  // ATOMIC_AGENT_INSTALL_ID_FILE, when set, is inherited unchanged with the rest of process.env.
  return out;
}

/* ---- the desktop state dir's config.json, read directly ---- */

/** The user config file as JSON, or null when absent / unreadable. `undefined` when the file is missing. */
export function readConfigFile(stateDir: string): Record<string, unknown> | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, "config.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `analytics.enabled` as `atag config get` would answer it: absent → true
 * (the schema default). A file that exists but cannot be parsed answers
 * false — when in doubt about an opt-out, nothing is sent.
 */
export function analyticsEnabledIn(cfg: Record<string, unknown> | null | undefined): boolean {
  if (cfg === undefined) return true;
  if (cfg === null) return false;
  const a = cfg["analytics"];
  if (!a || typeof a !== "object") return true;
  const enabled = (a as Record<string, unknown>)["enabled"];
  return enabled !== false;
}

/** local / cloud / fusion, as the window's run-mode chip shows it. */
export function runModeIn(cfg: Record<string, unknown> | null | undefined): "local" | "cloud" | "fusion" | null {
  if (cfg === null) return null;
  try {
    return resolveRunMode((cfg ?? {}) as unknown as RunModeConfig).effective;
  } catch {
    return null;
  }
}
