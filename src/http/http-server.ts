import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ApprovalBus } from "./approval-bus.js";
import { CompletionRegistry } from "./completion-registry.js";
import { openaiError } from "./openai-errors.js";
import {
  BodyParseError,
  BodyTooLargeError,
  enforceAuth,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

export interface RouteDefinition {
  method: string;
  /**
   * Path template. Literal segments match verbatim; a segment of the
   * shape `{name}` is captured into `ctx.params[name]`. Trailing slashes
   * are ignored. Paths are matched against the request URL pathname
   * only — query strings are accessible via the raw `req`.
   */
  path: string;
  handler: HttpHandler;
  /**
   * Whether to enforce bearer-token auth when an `apiKey` is
   * configured. Defaults to `true`; set to `false` for `/health` and
   * `/v1/models` which OpenAI SDKs probe pre-auth.
   */
  requiresAuth?: boolean;
}

export interface HttpServerOptions {
  runtime: AgentRuntime;
  host: string;
  port: number;
  apiKey: string | null;
  routes: RouteDefinition[];
  approvalBus?: ApprovalBus;
  completionRegistry?: CompletionRegistry;
}

export interface HttpServerHandle {
  server: Server;
  host: string;
  port: number;
  approvalBus: ApprovalBus;
  completionRegistry: CompletionRegistry;
  close: () => Promise<void>;
}

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  requiresAuth: boolean;
}

/**
 * Pre-compile a path template like `/api/skills/{name}` into a regex
 * and the ordered list of named captures. Literal segments are
 * regex-escaped; `{name}` turns into a greedy-ish `[^/]+` capture.
 */
function compileRoute(route: RouteDefinition): CompiledRoute {
  const segments = route.path.split("/").filter((s) => s.length > 0);
  const paramNames: string[] = [];
  const parts = segments.map((segment) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (match?.[1]) {
      paramNames.push(match[1]);
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const pattern = new RegExp(`^/${parts.join("/")}/?$`);
  return {
    method: route.method.toUpperCase(),
    pattern,
    paramNames,
    handler: route.handler,
    requiresAuth: route.requiresAuth ?? true,
  };
}

function matchRoute(
  routes: CompiledRoute[],
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const result = route.pattern.exec(pathname);
    if (!result) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, idx) => {
      const value = result[idx + 1];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    });
    return { route, params };
  }
  return null;
}

/**
 * Start the HTTP server and return a handle. The caller owns the
 * lifecycle — call `handle.close()` on shutdown. All error handling is
 * funnelled through `openaiError` envelopes so clients see a uniform
 * error shape.
 */
export function createHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  const approvalBus = options.approvalBus ?? new ApprovalBus();
  const completionRegistry =
    options.completionRegistry ?? new CompletionRegistry();
  const compiled = options.routes.map(compileRoute);

  const server = createServer(async (req, res) => {
    try {
      await dispatch(req, res, compiled, {
        runtime: options.runtime,
        apiKey: options.apiKey,
        approvalBus,
        completionRegistry,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  return new Promise<HttpServerHandle>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      rejectPromise(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address !== null ? address.port : options.port;
      resolvePromise({
        server,
        host: options.host,
        port: resolvedPort,
        approvalBus,
        completionRegistry,
        close: () => closeServer(server),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: CompiledRoute[],
  baseCtx: Omit<HandlerContext, "params">,
): Promise<void> {
  const url = parseRequestUrl(req);
  if (!url) {
    sendError(res, 400, openaiError("Malformed request URL"));
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const matched = matchRoute(routes, method, url.pathname);
  if (!matched) {
    sendError(
      res,
      404,
      openaiError(`No route for ${method} ${url.pathname}`, "invalid_request_error"),
    );
    return;
  }
  if (matched.route.requiresAuth && !enforceAuth(req, res, baseCtx.apiKey)) {
    return;
  }
  const ctx: HandlerContext = { ...baseCtx, params: matched.params };
  await matched.route.handler(req, res, ctx);
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try {
    return new URL(raw, "http://localhost");
  } catch {
    return null;
  }
}

function handleRouteError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // connection already torn down
    }
    return;
  }
  if (err instanceof BodyTooLargeError) {
    sendError(
      res,
      413,
      openaiError(err.message, "invalid_request_error", null, "payload_too_large"),
    );
    return;
  }
  if (err instanceof BodyParseError) {
    sendError(res, 400, openaiError(err.message));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(
    res,
    500,
    openaiError(`Internal server error: ${message}`, "server_error"),
  );
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}
