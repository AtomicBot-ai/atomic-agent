import type { ServerResponse } from "node:http";

import { getConfig } from "../config/index.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { setMcpServerEnabled } from "../tui/persist-mcp-server.js";

import { openaiError } from "./openai-errors.js";
import {
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/mcp/servers/{name}/restart` — stop + start one MCP server
 * live. Config is not touched. A server that is in config but unknown
 * to the live manager is connected instead. Mirrors `R` on the TUI MCP
 * tab.
 */
export function createRestartMcpServerHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const cfg = findConfiguredServer(ctx.params.name);
    if (!cfg) {
      sendNotFound(res, ctx.params.name);
      return;
    }
    const mgr = ctx.runtime.mcpManager;
    if (!(await mgr.restartServer(cfg.name))) await mgr.addServerLive(cfg);
    await ctx.runtime.refreshMcp();
    sendStatus(res, ctx, cfg.name);
  };
}

/**
 * `POST /api/mcp/servers/{name}/enable` and `.../disable` — persist the
 * server's `enabled` flag to `<stateDir>/config.json` (same write path
 * as the TUI add/remove) and connect or disconnect it live. Mirrors `e`
 * on the TUI MCP tab.
 */
export function createSetMcpServerEnabledHandler(
  enabled: boolean,
): HttpHandler {
  return async (_req, res, ctx) => {
    const cfg = findConfiguredServer(ctx.params.name);
    if (!cfg) {
      sendNotFound(res, ctx.params.name);
      return;
    }
    const { server } = setMcpServerEnabled(cfg.name, enabled);
    const mgr = ctx.runtime.mcpManager;
    if (!(await mgr.setServerEnabled(server.name, enabled))) {
      await mgr.addServerLive(server);
    }
    await ctx.runtime.refreshMcp();
    sendStatus(res, ctx, server.name);
  };
}

function findConfiguredServer(
  name: string | undefined,
): McpServerConfig | undefined {
  if (!name) return undefined;
  return getConfig().mcp?.servers.find((s) => s.name === name);
}

function sendNotFound(res: ServerResponse, name: string | undefined): void {
  sendError(
    res,
    404,
    openaiError(
      `MCP server ${JSON.stringify(name ?? "")} not found in config.mcp.servers`,
    ),
  );
}

function sendStatus(
  res: ServerResponse,
  ctx: HandlerContext,
  name: string,
): void {
  const status = ctx.runtime.mcpManager
    .listStatuses()
    .find((s) => s.name === name);
  sendJson(res, 200, { server: status ?? null });
}
