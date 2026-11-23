/**
 * `/mcp` on `atomic-agent serve` (ATO-549): the same MCP server as
 * `atomic-agent mcp-server`, over the MCP Streamable HTTP transport
 * (spec 2025-03-26 and 2025-06-18) instead of stdio.
 *
 * One endpoint, as the spec and the official SDK do it:
 * - `POST /mcp` takes a JSON-RPC message; the answer comes back as JSON
 *   or as an SSE stream, whichever the SDK transport picks.
 * - `initialize` (sent without `Mcp-Session-Id`) opens a session; the
 *   answer carries `Mcp-Session-Id`, and every later request must send it.
 * - `GET /mcp` opens the server's own SSE stream for that session.
 * - `DELETE /mcp` ends the session.
 *
 * The transport is the SDK's `StreamableHTTPServerTransport`, one per
 * session, connected to `createMcpServeServer` from the stdio command,
 * so the two transports list and run exactly the same tools.
 *
 * Auth is serve's: the route is authenticated like every `/api` route
 * (bearer key, or `x-api-key`), and the keyless loopback guard runs
 * before it. On top of that the spec asks servers to check `Origin` to
 * stop DNS rebinding, so every request with a foreign `Origin` is
 * refused here, with or without a key.
 *
 * Read-only only: memory recall, profile list, skills list and view.
 * The write and shell tools stay on `atomic-agent mcp-server` behind its
 * own flags, since over HTTP anyone holding the serve key would get them.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { getConfig } from "../config/index.js";
import { createMcpServeServer } from "../cli/mcp-server-bridge.js";
import { buildMcpServeTools } from "../cli/mcp-server-tools.js";
import { getAppVersion } from "../version.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { originAllowed } from "./loopback-guard.js";
import { getHeader, readJsonBody, type HttpHandler } from "./request-context.js";

export const MCP_ENDPOINT_PATH = "/mcp";
export const MCP_SESSION_HEADER = "mcp-session-id";

/** Open sessions kept at once; the least recently used goes first. */
export const MAX_MCP_HTTP_SESSIONS = 32;
/** A session nobody used for this long is closed. */
export const MCP_HTTP_SESSION_IDLE_MS = 60 * 60 * 1000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

export interface McpEndpointHandlers {
  post: HttpHandler;
  get: HttpHandler;
  delete: HttpHandler;
  /** Close every open session (tests; serve's own close drops the sockets). */
  closeAll: () => Promise<void>;
  /** How many sessions are open (tests). */
  sessionCount: () => number;
}

export interface McpEndpointOptions {
  /** `Date.now` by default. */
  now?: () => number;
}

export function createMcpEndpointHandlers(options: McpEndpointOptions = {}): McpEndpointHandlers {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const drop = (id: string): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    void session.server.close().catch(() => undefined);
  };

  const evict = (): void => {
    const cutoff = now() - MCP_HTTP_SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastUsed < cutoff) drop(id);
    while (sessions.size >= MAX_MCP_HTTP_SESSIONS) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [id, s] of sessions) {
        if (s.lastUsed < oldestAt) {
          oldest = id;
          oldestAt = s.lastUsed;
        }
      }
      if (oldest === null) break;
      drop(oldest);
    }
  };

  const open = async (runtime: AgentRuntime): Promise<StreamableHTTPServerTransport> => {
    evict();
    const server = buildServer(runtime);
    let session: Session | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (session) sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    session = { transport, server, lastUsed: now() };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
    };
    await server.connect(transport);
    return transport;
  };

  /** The session a request names, or `null` with the answer already sent. */
  const lookup = (req: IncomingMessage, res: ServerResponse): Session | null => {
    const id = getHeader(req, MCP_SESSION_HEADER);
    if (id === null) {
      sendRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return null;
    }
    const session = sessions.get(id);
    if (!session) {
      // The spec: an unknown or ended session is 404, and the client
      // starts over with a new initialize.
      sendRpcError(res, 404, -32001, "Session not found");
      return null;
    }
    session.lastUsed = now();
    return session;
  };

  const post: HttpHandler = async (req, res, ctx) => {
    if (!checkOrigin(req, res)) return;
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendRpcError(res, 400, -32700, "Parse error: the body must be JSON-RPC as JSON");
      return;
    }
    if (getHeader(req, MCP_SESSION_HEADER) === null) {
      if (!isInitialize(body)) {
        sendRpcError(res, 400, -32000, "Bad Request: send initialize first, or the Mcp-Session-Id header");
        return;
      }
      const transport = await open(ctx.runtime);
      await transport.handleRequest(req, res, body);
      return;
    }
    const session = lookup(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res, body);
  };

  const get: HttpHandler = async (req, res) => {
    if (!checkOrigin(req, res)) return;
    const session = lookup(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res);
  };

  const del: HttpHandler = async (req, res) => {
    if (!checkOrigin(req, res)) return;
    const session = lookup(req, res);
    if (!session) return;
    await session.transport.handleRequest(req, res);
  };

  return {
    post,
    get,
    delete: del,
    closeAll: async () => {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.server.close().catch(() => undefined)));
    },
    sessionCount: () => sessions.size,
  };
}

/**
 * The tools a session gets: the read-only set of `atomic-agent
 * mcp-server`, built from the stores this serve already holds open.
 * A memory family that is off in the config is left out, as there.
 */
function buildServer(runtime: AgentRuntime): McpServer {
  const mem = getConfig().memory;
  const workingDir = runtime.capabilities.workingDir;
  const toolSet = buildMcpServeTools(
    { allowWrite: false, allowExec: false, tools: [] },
    {
      ...(mem.notes.enabled ? { notesStore: runtime.notesStore } : {}),
      ...(mem.profile.enabled ? { profileStore: runtime.profileStore } : {}),
      ...(mem.lessons.enabled ? { lessonStore: runtime.lessonStore } : {}),
      ...(mem.procedures.enabled ? { procedureStore: runtime.procedureStore } : {}),
      notesRecallDefaultK: mem.notes.recallDefaultK,
      notesMaxContentChars: mem.notes.maxContentChars,
      skillRegistry: runtime.skillRegistry,
      // Unused: no tool in the read-only set asks for approval.
      approvals: runtime.approvals,
    },
  );
  return createMcpServeServer({ toolSet, workingDir, version: getAppVersion() });
}

function isInitialize(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((m) => isInitializeRequest(m));
  return isInitializeRequest(body);
}

/**
 * The spec's DNS rebinding check: no `Origin` (CLI clients, Claude Code,
 * Codex), a loopback one, or one listed in `ATOMIC_AGENT_ALLOWED_ORIGINS`.
 */
function checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (originAllowed(getHeader(req, "origin"))) return true;
  sendRpcError(res, 403, -32000, "Forbidden: this Origin may not use the MCP endpoint");
  return false;
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}
