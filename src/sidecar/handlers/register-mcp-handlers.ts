import {
  addMcpServer,
  listMcp,
  refreshMcp,
  removeMcpServer,
  type McpServiceDeps,
} from "../../runtime-api/index.js";
import {
  persistMcpServer,
  removeMcpServer as removeMcpServerConfig,
} from "../../tui/persist-mcp-server.js";
import type {
  McpAddPayload,
  McpAddResult,
  McpListPayload,
  McpListResult,
  McpRefreshPayload,
  McpRefreshResult,
  McpRemovePayload,
  McpRemoveResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `mcp.*` — live MCP client control. `add` / `remove` follow the TUI
 * "persist config first, then live-mutate + refreshMcp" contract; the
 * config-persistence primitives are reused from the TUI module so there is
 * one source of truth. Every mutation emits an `mcp.status` snapshot.
 */
export function registerMcpHandlers(ctx: SidecarHandlerContext): void {
  const { router, protocol, runtime } = ctx;

  const deps: McpServiceDeps = {
    mcpManager: runtime.mcpManager,
    refreshMcp: () => runtime.refreshMcp(),
    persistServer: persistMcpServer,
    removeServerConfig: (name) => {
      removeMcpServerConfig(name);
    },
  };

  const emitStatus = (): void => {
    protocol.emitEvent("mcp.status", {
      servers: runtime.mcpManager.listStatuses(),
    });
  };

  router.register<McpListPayload, McpListResult>("mcp.list", () =>
    listMcp(deps),
  );

  router.register<McpAddPayload, McpAddResult>("mcp.add", async (request) => {
    const result = await addMcpServer(deps, request.payload.config);
    emitStatus();
    return result;
  });

  router.register<McpRemovePayload, McpRemoveResult>(
    "mcp.remove",
    async (request) => {
      const result = await removeMcpServer(deps, request.payload.name);
      emitStatus();
      return result;
    },
  );

  router.register<McpRefreshPayload, McpRefreshResult>(
    "mcp.refresh",
    async () => {
      await refreshMcp(deps);
      emitStatus();
      return { ok: true };
    },
  );
}
