/**
 * Request/response payload shapes for the `mcp.*` commands. See SIDECAR.md
 * §4.6. `mcp.add` / `mcp.remove` follow the TUI "persist first, then
 * live-mutate + refresh" contract; server state changes emit `mcp.status`.
 */
import type {
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
  McpToolMeta,
} from "../../mcp/index.js";

export interface McpListPayload {
  [key: string]: never;
}
export interface McpListResult {
  servers: McpServerStatus[];
  catalogs: McpServerCatalog[];
}

export interface McpAddPayload {
  config: McpServerConfig;
}
export interface McpAddResult {
  added: boolean;
  tools: McpToolMeta[];
}

export interface McpRemovePayload {
  name: string;
}
export interface McpRemoveResult {
  removed: boolean;
  tools: string[];
}

export interface McpRefreshPayload {
  [key: string]: never;
}
export interface McpRefreshResult {
  ok: true;
}
