import { parseBool } from "./config-primitives.js";

/**
 * `network` block of config.json (unversioned, additive, ATO-1084).
 *
 * - `offline` (default `false`): the network kill switch. When `true`
 *   the agent refuses every outbound connection whose host is not this
 *   machine (`localhost`, `127.0.0.0/8`, `::1`): the process-wide HTTP
 *   pool, the web/HTTP tools, the browser tools, remote MCP servers,
 *   subscription CLI providers, the Telegram bot and anonymous
 *   analytics / crash reports. Local models keep working. Env
 *   `ATOMIC_AGENT_OFFLINE=1` turns it on for one process whatever the
 *   file says; neither can be turned off for a process already running.
 *   Shell commands and stdio MCP servers are separate programs and are
 *   not network-isolated (see src/llm/docs/offline-network.md).
 */
/** Env switch: `1` / `true` / `yes` / `on` turns offline mode on for the process. */
export const OFFLINE_ENV = "ATOMIC_AGENT_OFFLINE";

export interface NetworkConfig {
  offline: boolean;
}

export function createNetworkDefaults(): NetworkConfig {
  return { offline: false };
}

export function parseNetworkConfig(
  raw: Record<string, unknown>,
  readDefaults: () => NetworkConfig,
): NetworkConfig {
  const defaults = readDefaults();
  return {
    offline: parseBool(raw.offline ?? defaults.offline, "network.offline"),
  };
}
