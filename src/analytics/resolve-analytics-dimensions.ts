import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSurface, type AnalyticsSurface } from "./resolve-surface.js";

/**
 * Process-wide dimensions stamped on every analytics event and every
 * error report. Each value is a fixed enum word or a version string —
 * never a path, a host, or anything the operator typed.
 */
export interface AnalyticsDimensions {
  surface: AnalyticsSurface;
  /** `process.arch` (`arm64` / `x64` / …). */
  arch: string;
  /** How this copy was installed (see {@link INSTALL_CHANNELS}). */
  installChannel: InstallChannel;
  /** Desktop app version, only when running under the desktop app. */
  desktopVersion?: string;
}

/** Every install channel value that may leave the machine. */
export const INSTALL_CHANNELS = [
  "curl_sh",
  "curl_ps1",
  "dmg",
  "exe",
  "appimage",
  "deb",
  "unknown",
] as const;
export type InstallChannel = (typeof INSTALL_CHANNELS)[number];

export const INSTALL_CHANNEL_ENV = "ATOMIC_AGENT_INSTALL_CHANNEL";
export const DESKTOP_VERSION_ENV = "ATOMIC_AGENT_DESKTOP_VERSION";
/** Marker file written by `scripts/install.sh` / `install.ps1`. */
export const INSTALL_CHANNEL_FILE = "install-channel";

/** Narrow an arbitrary value to a known channel, else `undefined`. */
export function parseInstallChannel(
  value: unknown,
): InstallChannel | undefined {
  if (typeof value !== "string") return undefined;
  // Strip a UTF-8 BOM a Windows editor may have added, plus whitespace.
  const trimmed = value.replace(/^\uFEFF/, "").trim().toLowerCase();
  return (INSTALL_CHANNELS as readonly string[]).includes(trimmed)
    ? (trimmed as InstallChannel)
    : undefined;
}

/**
 * Resolve the install channel: the env set by the desktop app wins, then
 * the `<stateDir>/install-channel` marker written by the install scripts,
 * else `unknown`. Anything outside the enum is treated as absent.
 */
export function resolveInstallChannel(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallChannel {
  const fromEnv = parseInstallChannel(env[INSTALL_CHANNEL_ENV]);
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(stateDir, INSTALL_CHANNEL_FILE), "utf8");
    const fromFile = parseInstallChannel(raw.split(/\r?\n/, 1)[0]);
    if (fromFile) return fromFile;
  } catch {
    // Missing / unreadable marker → unknown.
  }
  return "unknown";
}

/** Desktop version from env, kept only when it looks like a version. */
export function resolveDesktopVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[DESKTOP_VERSION_ENV]?.trim();
  if (!raw) return undefined;
  return /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(raw) ? raw : undefined;
}

/** Build the dimensions for this process. */
export function resolveAnalyticsDimensions(options: {
  stateDir: string;
  surface?: AnalyticsSurface;
  env?: NodeJS.ProcessEnv;
}): AnalyticsDimensions {
  const env = options.env ?? process.env;
  const desktopVersion = resolveDesktopVersion(env);
  return {
    surface: resolveSurface(options.surface, env),
    arch: process.arch,
    installChannel: resolveInstallChannel(options.stateDir, env),
    ...(desktopVersion !== undefined ? { desktopVersion } : {}),
  };
}

/**
 * Whether the *other* surface has ever run on this machine: the desktop
 * agent looks for the terminal state dir's `analytics.json`, the terminal
 * looks for the desktop's. Only a boolean leaves the machine. Uses the
 * home-based default dirs; always `false` under the test runner so the
 * suite never depends on the developer's home.
 */
export function detectOtherSurfaceInstalled(
  surface: AnalyticsSurface,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VITEST !== undefined || env.NODE_ENV === "test") return false;
  return otherSurfaceAnalyticsExists(surface, home);
}

/** Pure part of {@link detectOtherSurfaceInstalled}, exported for tests. */
export function otherSurfaceAnalyticsExists(
  surface: AnalyticsSurface,
  home: string,
): boolean {
  const otherDir =
    surface === "desktop" ? ".atomic-agent" : ".atomic-agent-desktop";
  try {
    return existsSync(join(home, otherDir, "analytics.json"));
  } catch {
    return false;
  }
}
