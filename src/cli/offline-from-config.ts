import { readFileSync } from "node:fs";

import { getUserConfigPath, resolveStateDir } from "../config/index.js";
import { setOfflineNetwork } from "../llm/offline-network.js";

const ON_STRINGS = new Set(["1", "true", "yes", "on"]);

/**
 * Apply `network.offline` from config.json before any command runs
 * (ATO-1084).
 *
 * The runtime applies the switch when it starts, but several commands
 * never build one (`update`, the skill and plugin hubs, `models`), and
 * their requests went out with offline mode on in the file. The CLI
 * entry calls this right after installing the global dispatcher, so
 * the guard sees the flag from the first request of any command.
 *
 * Read-only: `getConfig()` writes or migrates the file on first use,
 * which `--help` and an install path must not do, so this reads the
 * raw JSON itself. A missing, unreadable or malformed file means "not
 * asked for" and the command runs as before. Only a value that
 * `network.offline` would parse as true turns the mode on; this never
 * turns it off (`ATOMIC_AGENT_OFFLINE` is read by the guard itself).
 *
 * Returns whether the file asked for offline mode.
 */
export function applyOfflineModeFromConfigFile(
  stateDir: string = resolveStateDir(),
): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(getUserConfigPath(stateDir), "utf8"));
  } catch {
    return false;
  }
  if (!fileAsksOffline(raw)) return false;
  setOfflineNetwork(true);
  return true;
}

function fileAsksOffline(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const network = (raw as { network?: unknown }).network;
  if (typeof network !== "object" || network === null) return false;
  const offline = (network as { offline?: unknown }).offline;
  if (offline === true) return true;
  return typeof offline === "string" && ON_STRINGS.has(offline.toLowerCase());
}
