import type { ServerResponse } from "node:http";

import { getConfig } from "../config/index.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { setMcpServerEnabled } from "../config/mcp-server-commands.js";
import {
  McpOAuthFlow,
  McpOAuthFlowError,
  type McpOAuthFlowErrorCode,
} from "../mcp/mcp-oauth-flow.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

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

export interface McpOAuthHandlers {
  readonly start: HttpHandler;
  readonly status: HttpHandler;
  readonly signOut: HttpHandler;
}

/**
 * `POST /api/mcp/servers/{name}/auth/start`, `GET .../auth` and
 * `POST .../auth/signout`: browser sign-in (OAuth) for a remote MCP
 * server, the same flow the TUI's `/mcp auth <name>` runs.
 *
 * - `start` answers `{ state: "pending", authUrl }`: the caller opens
 *   `authUrl` in a browser (the agent never does). When a saved refresh
 *   token was enough it answers `{ state: "signed_in" }` instead. The
 *   browser lands on a loopback listener the agent opened on 127.0.0.1;
 *   the server is reconnected once the sign-in finishes.
 * - `status` answers `{ state: "signed_out" | "pending" | "signed_in",
 *   error? }`.
 * - `signout` deletes the saved sign-in, reconnects the server and
 *   answers `{ state: "signed_out" }`.
 *
 * One flow per route table (like Telegram pairing): created on the first
 * request, from that request's runtime.
 */
export function createMcpOAuthHandlers(): McpOAuthHandlers {
  let flow: McpOAuthFlow | null = null;
  const flowFor = (runtime: AgentRuntime): McpOAuthFlow => {
    if (flow) return flow;
    flow = new McpOAuthFlow({
      stateDir: runtime.config.paths.stateDir,
      findServer: (name) =>
        runtime.mcpManager.getServerConfig(name) ?? findConfiguredServer(name),
      reconnect: async (name) => {
        const mgr = runtime.mcpManager;
        if (!(await mgr.restartServer(name))) {
          const cfg = findConfiguredServer(name);
          if (cfg) await mgr.addServerLive(cfg);
        }
        await runtime.refreshMcp();
      },
    });
    return flow;
  };

  return {
    start: async (_req, res, ctx) => {
      try {
        const result = await flowFor(ctx.runtime).start(ctx.params.name ?? "");
        sendJson(res, 200, result);
      } catch (err) {
        sendFlowError(res, err);
      }
    },
    status: async (_req, res, ctx) => {
      try {
        sendJson(res, 200, flowFor(ctx.runtime).status(ctx.params.name ?? ""));
      } catch (err) {
        sendFlowError(res, err);
      }
    },
    signOut: async (_req, res, ctx) => {
      try {
        await flowFor(ctx.runtime).signOut(ctx.params.name ?? "");
        sendJson(res, 200, { state: "signed_out" });
      } catch (err) {
        sendFlowError(res, err);
      }
    },
  };
}

const FLOW_ERROR_STATUS: Record<McpOAuthFlowErrorCode, number> = {
  not_found: 404,
  not_remote: 409,
  uses_key: 409,
  failed: 502,
};

function sendFlowError(res: ServerResponse, err: unknown): void {
  if (err instanceof McpOAuthFlowError) {
    sendError(
      res,
      FLOW_ERROR_STATUS[err.code],
      openaiError(err.message, "invalid_request_error", null, `mcp_auth_${err.code}`),
    );
    return;
  }
  sendError(
    res,
    500,
    openaiError("Sign-in failed because of an internal error.", "server_error"),
  );
}
