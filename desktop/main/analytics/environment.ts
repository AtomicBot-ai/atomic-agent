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

/** `app.isPackaged`, read lazily; false outside Electron (plain node, the unit tests). */
export function packagedApp(): boolean {
  try {
    const electron = require("electron") as { app?: { isPackaged?: boolean } };
    return electron?.app?.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * A run that must send nothing and write nothing to the real home: the test
 * harness (VITEST, NODE_ENV=test, the smoke / probe / drive flags), a
 * developer's run (`--dev`, NODE_ENV=development, an unpackaged build unless
 * ATOMIC_DESKTOP_ANALYTICS=on), or ATOMIC_DESKTOP_ANALYTICS=off.
 */
export function isTestRun(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = packagedApp(),
): boolean {
  if (env.VITEST !== undefined || env.NODE_ENV === "test" || env.NODE_ENV === "development") return true;
  if (env.ATOMIC_DESKTOP_ANALYTICS === "off") return true;
  const flagged = argv.some((a) =>
    a === "--smoke" || a === "--first-run-probe" || a === "--models" || a === "--dev"
    || a.startsWith("--smoke-") || a.startsWith("--remote-debugging-port") || a.startsWith("--fake-ram="),
  );
  if (flagged) return true;
  return !packaged && env.ATOMIC_DESKTOP_ANALYTICS !== "on";
}

/** What the spawned agent must know about the shell's own gate (core.ts keeps it current). */
export interface AgentGate {
  testRun: boolean;
  /** The terminal opt-out the desktop inherited (its own config has no analytics.enabled). */
  inheritedOff: boolean;
}
let agentGate: () => AgentGate = () => ({ testRun: isTestRun(), inheritedOff: false });
export function setAgentGate(fn: () => AgentGate): void {
  agentGate = fn;
}

/**
 * What `agentEnv()` adds for the agent's own analytics (desktop/ANALYTICS.md
 * "Environment passed to the agent"). On a test or dev run the agent sends
 * nothing and keeps its install id inside the state dir, never in the real
 * home; an inherited terminal opt-out is passed on the same way.
 */
export function agentAnalyticsEnv(stateDir: string): Record<string, string> {
  const out: Record<string, string> = {
    ATOMIC_AGENT_SURFACE: "desktop",
    ATOMIC_AGENT_INSTALL_CHANNEL: installChannelFor(process.platform, process.env),
  };
  const v = desktopVersion();
  if (v) out.ATOMIC_AGENT_DESKTOP_VERSION = v;
  // ATOMIC_AGENT_INSTALL_ID_FILE, when set, is inherited unchanged with the rest of process.env.
  try {
    const g = agentGate();
    if (g.testRun) {
      out.ATOMIC_AGENT_ANALYTICS = "off";
      out.ATOMIC_AGENT_INSTALL_ID_FILE = join(stateDir, "install-id");
    } else if (g.inheritedOff) {
      out.ATOMIC_AGENT_ANALYTICS = "off";
    }
  } catch {
    out.ATOMIC_AGENT_ANALYTICS = "off";
  }
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

type Cfg = Record<string, unknown> | null | undefined;

/** `analytics.enabled` when the file says it outright (true / false), else undefined. */
export function explicitAnalyticsEnabled(cfg: Cfg): boolean | undefined {
  if (!cfg) return undefined;
  const a = cfg["analytics"];
  if (!a || typeof a !== "object") return undefined;
  const enabled = (a as Record<string, unknown>)["enabled"];
  return typeof enabled === "boolean" ? enabled : undefined;
}

/**
 * `analytics.enabled` as `atag config get` would answer it: absent → true
 * (the schema default). A file that exists but cannot be parsed answers
 * false — when in doubt about an opt-out, nothing is sent.
 */
export function analyticsEnabledIn(cfg: Cfg): boolean {
  if (cfg === null) return false;
  return explicitAnalyticsEnabled(cfg) !== false;
}

/** The desktop has no say of its own and the terminal agent's config opted out. */
export function inheritedOptOut(desktopCfg: Cfg, tuiCfg: Cfg): boolean {
  return desktopCfg !== null && explicitAnalyticsEnabled(desktopCfg) === undefined && explicitAnalyticsEnabled(tuiCfg) === false;
}

/**
 * The shell's gate: the desktop config's own answer when it gives one;
 * without one, an earlier opt-out in the terminal agent's config is
 * respected (one person, one machine, one choice).
 */
export function analyticsEnabledFor(desktopCfg: Cfg, tuiCfg: Cfg): boolean {
  if (!analyticsEnabledIn(desktopCfg)) return false;
  return !inheritedOptOut(desktopCfg, tuiCfg);
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
