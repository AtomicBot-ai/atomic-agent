/**
 * Which of a server's tools the agent is offered (ATO-705).
 *
 * `enabledTools` is an allowlist (absent means every tool the server
 * lists) and `disabledTools` a denylist applied on top, the same split
 * Codex uses. Names are the server's raw tool names, not the qualified
 * `mcp.<server>.<tool>` form. A filtered-out tool is dropped at
 * discovery: it never reaches the catalog, the tool descriptors, the
 * grammar or the registry, so it costs no prompt space and cannot be
 * called. A change takes effect when the server reconnects.
 */
import type { McpServerConfig } from "./mcp-types.js";

export function isMcpToolEnabled(
  config: Pick<McpServerConfig, "enabledTools" | "disabledTools">,
  rawName: string,
): boolean {
  if (config.enabledTools !== undefined && !config.enabledTools.includes(rawName)) {
    return false;
  }
  return !(config.disabledTools ?? []).includes(rawName);
}
