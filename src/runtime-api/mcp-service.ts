import type {
  McpManager,
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
  McpToolMeta,
} from "../mcp/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * MCP client control surface shared by the sidecar `mcp.*` handlers (and any
 * future HTTP route). Mirrors the TUI orchestrator's "persist first, then
 * live-mutate + refresh" contract, but the config-persistence primitives are
 * **injected** (`persistServer` / `removeServerConfig`) so this facade stays
 * free of the TUI layer while still reusing one implementation — no drift.
 *
 * Live-connect / live-disconnect failures are non-fatal: config.json is the
 * durable source of truth, so a failed live mutation still leaves the server
 * persisted (it retries on the next runtime boot). This matches the TUI's
 * graceful-degradation handling.
 */
export interface McpServiceDeps {
  mcpManager: Pick<
    McpManager,
    "listStatuses" | "listCatalogs" | "addServerLive" | "removeServerLive"
  >;
  refreshMcp: () => Promise<void>;
  /** Append a validated server to config.json. Throws on dup / invalid. */
  persistServer: (server: McpServerConfig) => void;
  /** Remove a server from config.json by name. Throws when absent. */
  removeServerConfig: (name: string) => void;
}

export interface McpListResult {
  servers: McpServerStatus[];
  catalogs: McpServerCatalog[];
}

export interface McpAddResult {
  added: boolean;
  tools: McpToolMeta[];
}

export interface McpRemoveResult {
  removed: boolean;
  tools: string[];
}

export function listMcp(deps: McpServiceDeps): McpListResult {
  return {
    servers: deps.mcpManager.listStatuses(),
    catalogs: deps.mcpManager.listCatalogs(),
  };
}

export async function addMcpServer(
  deps: McpServiceDeps,
  config: McpServerConfig,
): Promise<McpAddResult> {
  if (!config || typeof config !== "object") {
    throw new RuntimeApiError("config is required", "invalid_request", "config");
  }
  try {
    deps.persistServer(config);
  } catch (err) {
    throw new RuntimeApiError(errorMessage(err), "invalid_request", "config");
  }
  try {
    const result = await deps.mcpManager.addServerLive(config);
    await deps.refreshMcp();
    return result;
  } catch {
    // Persisted but live connect failed — retried on next boot. Report as
    // not-yet-live rather than failing the whole call (config is durable).
    return { added: false, tools: [] };
  }
}

export async function removeMcpServer(
  deps: McpServiceDeps,
  name: string,
): Promise<McpRemoveResult> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RuntimeApiError("name is required", "invalid_request", "name");
  }
  try {
    deps.removeServerConfig(name);
  } catch (err) {
    throw new RuntimeApiError(errorMessage(err), "not_found", "name");
  }
  try {
    const result = await deps.mcpManager.removeServerLive(name);
    await deps.refreshMcp();
    return result;
  } catch {
    // Removed from config but live disconnect failed — dropped on next boot.
    return { removed: false, tools: [] };
  }
}

export async function refreshMcp(deps: McpServiceDeps): Promise<void> {
  await deps.refreshMcp();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
