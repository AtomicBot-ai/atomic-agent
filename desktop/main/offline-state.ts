/**
 * ATO-1085: the desktop's own view of offline mode (the agent's network
 * kill switch, ATO-1084). The agent owns the switch; the desktop shell
 * has its own outbound traffic (PostHog, Sentry, the app update check)
 * that the agent's dispatcher cannot see, so it follows the same switch:
 *
 *   - at start, from `network.offline` in the agent's config.json (the
 *     desktop's state dir) or `ATOMIC_AGENT_OFFLINE=1`;
 *   - after that, from every answer of `GET/POST /api/offline-mode`
 *     (Settings › Privacy reads it on entry and every 5 s while open).
 *
 * `ATOMIC_AGENT_OFFLINE=1` keeps it on whatever it is told, like the
 * agent. No Electron import: the unit tests load it in plain Node.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OFFLINE_ENV = "ATOMIC_AGENT_OFFLINE";
const ON_VALUES = new Set(["1", "true", "yes", "on"]);

let bySetting = false;
const listeners: Array<(on: boolean) => void> = [];

/** `ATOMIC_AGENT_OFFLINE` asks for offline mode (same values as the agent). */
export function offlineByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OFFLINE_ENV];
  return typeof raw === "string" && ON_VALUES.has(raw.trim().toLowerCase());
}

/** `network.offline === true` in a parsed config.json; anything else is off. */
export function offlineInConfig(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const network = (cfg as { network?: unknown }).network;
  if (!network || typeof network !== "object") return false;
  return (network as { offline?: unknown }).offline === true;
}

/** Read `<stateDir>/config.json`; missing or malformed reads as off. */
export function offlineInStateDir(stateDir: string): boolean {
  try {
    return offlineInConfig(JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")));
  } catch {
    return false;
  }
}

/** Is the desktop shell offline right now? */
export function desktopOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return bySetting || offlineByEnv(env);
}

/** Follow the agent's switch. Listeners hear only real changes. */
export function setDesktopOffline(on: boolean): void {
  const was = desktopOffline();
  bySetting = on;
  const now = desktopOffline();
  if (was === now) return;
  for (const cb of listeners) {
    try {
      cb(now);
    } catch {
      /* a listener's failure is not the switch's */
    }
  }
}

/** Subscribe to changes (analytics drops its queue, the updater stops asking). */
export function onDesktopOfflineChange(cb: (on: boolean) => void): void {
  listeners.push(cb);
}

/**
 * An `/api/offline-mode` answer as `AgentClient.offlineMode` returns it:
 * `{supported: true, ok: true, data: {enabled}}` updates the switch,
 * anything else (old agent, error) leaves it as it is.
 */
export function followOfflineAnswer(res: unknown): void {
  if (!res || typeof res !== "object") return;
  const r = res as { supported?: unknown; ok?: unknown; data?: { enabled?: unknown } | null };
  if (r.supported !== true || r.ok !== true) return;
  if (typeof r.data?.enabled !== "boolean") return;
  setDesktopOffline(r.data.enabled);
}

/** Test seam. */
export function resetDesktopOfflineForTests(): void {
  bySetting = false;
  listeners.length = 0;
}
