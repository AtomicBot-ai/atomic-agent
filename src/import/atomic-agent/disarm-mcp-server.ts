import type { McpServerConfig } from "../../mcp/mcp-types.js";

/**
 * ATO-2473: an MCP server from another Atomic Agent data folder runs a
 * command on this computer, and that folder may be someone else's or
 * tampered with. So it arrives switched off, with the source's own
 * approval and trust choices dropped (`approval`, `trust`,
 * `trustedReadOnlyTools`), the way a shared setup bundle imports it
 * (setup-share/setup-import-parts.ts `disarmStagedMcpServers`). Once the
 * person checks the command and turns it on, its tools ask before each
 * call like any new server's. Precedent: Claude Code asks before it starts
 * a server from a project `.mcp.json` it has not seen.
 */
export function disarmImportedMcpServer(entry: Record<string, unknown>): McpServerConfig {
  const server: Record<string, unknown> = { ...entry, enabled: false };
  delete server.approval;
  delete server.trust;
  delete server.trustedReadOnlyTools;
  return server as unknown as McpServerConfig;
}

/** The report line for a server that came over switched off. */
export const IMPORTED_MCP_OFF_REASON =
  "added switched off, since it runs a program on this computer: check its command, then turn it on in the MCP list";
