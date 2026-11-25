/**
 * Browser sign-in (OAuth) for remote MCP servers, shared by the HTTP
 * routes (desktop) and the TUI.
 *
 *   1. `start(name)` opens a loopback listener on 127.0.0.1 (one for all
 *      sign-ins in progress), runs the SDK's OAuth step (discovery and
 *      dynamic client registration happen here) and returns the
 *      authorization URL. The caller opens it in a browser; the agent
 *      never does, it may be headless or on another machine.
 *   2. The browser comes back to `http://127.0.0.1:<port>/callback` with
 *      `code` and `state`. A `state` this flow did not hand out is
 *      refused (CSRF). The code is exchanged for tokens, the browser gets
 *      a short "you can close this tab" page and the server is
 *      reconnected so its tools appear.
 *   3. A sign-in not finished within `timeoutMs` (5 minutes) expires.
 *      The listener closes once no sign-in is in progress.
 *
 * `status(name)` reads `signed_out` / `pending` / `signed_in` (a token is
 * saved). `signOut(name)` deletes the saved sign-in and reconnects.
 * Error messages are plain sentences meant for the person.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { runMcpOAuth } from "./mcp-client.js";
import { scrubErrorMessage } from "./mcp-errors.js";
import {
  hasStaticCredentialHeader,
  MCP_OAUTH_CALLBACK_HOST,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_DEFAULT_PORT,
  McpOAuthProvider,
  mcpOAuthRedirectUri,
} from "./mcp-oauth-provider.js";
import { createMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";
import type { McpServerConfig } from "./mcp-types.js";

/** How long a started sign-in waits for the browser. */
export const MCP_OAUTH_SIGNIN_TIMEOUT_MS = 5 * 60_000;

/** Default port first, then the next four, then any free port. */
export const MCP_OAUTH_PORTS: readonly number[] = [
  MCP_OAUTH_DEFAULT_PORT,
  MCP_OAUTH_DEFAULT_PORT + 1,
  MCP_OAUTH_DEFAULT_PORT + 2,
  MCP_OAUTH_DEFAULT_PORT + 3,
  MCP_OAUTH_DEFAULT_PORT + 4,
  0,
];

export type McpOAuthSignInState = "signed_out" | "pending" | "signed_in";

export interface McpOAuthStatus {
  state: McpOAuthSignInState;
  /** Why the last sign-in did not finish, as a plain sentence. */
  error?: string;
}

export type McpOAuthStartResult =
  | { state: "pending"; authUrl: string }
  /** A saved refresh token was enough; no browser needed. */
  | { state: "signed_in" };

export type McpOAuthFlowErrorCode = "not_found" | "not_remote" | "uses_key" | "failed";

export class McpOAuthFlowError extends Error {
  constructor(
    public readonly code: McpOAuthFlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthFlowError";
  }
}

type Authorize = (
  provider: McpOAuthProvider,
  options: { serverUrl: string; authorizationCode?: string },
) => Promise<"AUTHORIZED" | "REDIRECT">;

export interface McpOAuthFlowDeps {
  stateDir: string;
  /** The live config of a server, or `undefined` when there is none. */
  findServer(name: string): McpServerConfig | undefined;
  /** Reconnect one server so its tools reflect the new sign-in. */
  reconnect(name: string): Promise<void>;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** Test seams. */
  timeoutMs?: number;
  ports?: readonly number[];
  authorize?: Authorize;
}

interface PendingSignIn {
  server: string;
  url: string;
  provider: McpOAuthProvider;
  timer: NodeJS.Timeout;
}

export class McpOAuthFlow {
  private readonly store: McpOAuthStore;
  private readonly authorize: Authorize;
  private readonly timeoutMs: number;
  /** Keyed by the `state` value handed to the authorization server. */
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly lastErrors = new Map<string, string>();
  /** Servers whose browser came back and whose code is being exchanged: still "pending" to a poller. */
  private readonly exchanging = new Set<string>();
  /** Sign-ins between `ensureListener` and `pending.set`: the listener must stay open for them. */
  private starting = 0;
  private listener: Server | null = null;
  private listenerPort: number | null = null;
  private listening: Promise<number> | null = null;

  constructor(private readonly deps: McpOAuthFlowDeps) {
    this.store = createMcpOAuthStore(deps.stateDir);
    this.authorize = deps.authorize ?? runMcpOAuth;
    this.timeoutMs = deps.timeoutMs ?? MCP_OAUTH_SIGNIN_TIMEOUT_MS;
  }

  /** Begin a sign-in. Throws `McpOAuthFlowError` with a plain message. */
  async start(name: string): Promise<McpOAuthStartResult> {
    const { url } = this.remoteServer(name);
    this.cancel(name);
    this.lastErrors.delete(name);
    this.starting += 1;
    try {
      return await this.startWithListener(name, url);
    } finally {
      this.starting -= 1;
      this.closeListenerIfIdle();
    }
  }

  private async startWithListener(name: string, url: string): Promise<McpOAuthStartResult> {
    const port = await this.ensureListener();
    const provider = new McpOAuthProvider({
      store: this.store,
      server: name,
      url,
      mode: "signin",
      redirectUri: mcpOAuthRedirectUri(port),
    });
    let result: "AUTHORIZED" | "REDIRECT";
    try {
      result = await this.authorize(provider, { serverUrl: url });
    } catch (err) {
      this.closeListenerIfIdle();
      const message = `Could not start sign-in: ${scrubErrorMessage(err)}`;
      this.lastErrors.set(name, message);
      this.deps.logger?.warn("mcp.oauth_start_failed", { server: name });
      throw new McpOAuthFlowError("failed", message);
    }
    if (result === "AUTHORIZED") {
      this.closeListenerIfIdle();
      await this.reconnectQuietly(name);
      return { state: "signed_in" };
    }
    const request = provider.pendingAuthorization();
    if (!request) {
      this.closeListenerIfIdle();
      throw new McpOAuthFlowError("failed", "The server did not return a sign-in page.");
    }
    const timer = setTimeout(() => this.expire(request.state), this.timeoutMs);
    timer.unref?.();
    this.pending.set(request.state, { server: name, url, provider, timer });
    this.deps.logger?.info("mcp.oauth_pending", { server: name });
    return { state: "pending", authUrl: request.authUrl };
  }

  status(name: string): McpOAuthStatus {
    const server = this.deps.findServer(name);
    if (!server) throw notFound(name);
    const error = this.lastErrors.get(name);
    if (server.transport.kind === "stdio") return { state: "signed_out" };
    if (this.pendingFor(name) || this.exchanging.has(name)) return { state: "pending" };
    if (this.store.hasTokens(name, server.transport.url)) return { state: "signed_in" };
    return error ? { state: "signed_out", error } : { state: "signed_out" };
  }

  /** Delete the saved sign-in and reconnect the server. */
  async signOut(name: string): Promise<void> {
    const server = this.deps.findServer(name);
    if (!server) throw notFound(name);
    this.cancel(name);
    this.lastErrors.delete(name);
    this.store.clear(name);
    this.deps.logger?.info("mcp.oauth_signed_out", { server: name });
    await this.reconnectQuietly(name);
  }

  /** Port the callback listener is bound to, or `null` when closed. */
  get callbackPort(): number | null {
    return this.listenerPort;
  }

  /** Stop every sign-in in progress and close the listener. */
  async dispose(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.closeListener();
  }

  private remoteServer(name: string): { url: string } {
    const server = this.deps.findServer(name);
    if (!server) throw notFound(name);
    const t = server.transport;
    if (t.kind === "stdio") {
      throw new McpOAuthFlowError(
        "not_remote",
        "This server runs on this computer, so it has no browser sign-in.",
      );
    }
    if (hasStaticCredentialHeader(t.headers)) {
      throw new McpOAuthFlowError(
        "uses_key",
        "This server already has a key in its settings, so it does not use browser sign-in.",
      );
    }
    return { url: t.url };
  }

  private pendingFor(name: string): [string, PendingSignIn] | undefined {
    for (const entry of this.pending.entries()) {
      if (entry[1].server === name) return entry;
    }
    return undefined;
  }

  private cancel(name: string): void {
    const entry = this.pendingFor(name);
    if (!entry) return;
    clearTimeout(entry[1].timer);
    this.pending.delete(entry[0]);
  }

  private expire(state: string): void {
    const entry = this.pending.get(state);
    if (!entry) return;
    this.pending.delete(state);
    this.lastErrors.set(entry.server, "Sign-in timed out. Start it again.");
    this.closeListenerIfIdle();
  }

  private async reconnectQuietly(name: string): Promise<void> {
    try {
      await this.deps.reconnect(name);
    } catch (err) {
      this.deps.logger?.warn("mcp.oauth_reconnect_failed", {
        server: name,
        reason: scrubErrorMessage(err),
      });
    }
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", `http://${MCP_OAUTH_CALLBACK_HOST}`);
    if (req.method !== "GET" || reqUrl.pathname !== MCP_OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const state = reqUrl.searchParams.get("state") ?? "";
    const entry = state ? this.pending.get(state) : undefined;
    if (!entry) {
      sendPage(res, 400, "This sign-in link has expired or was already used. Start sign-in again from Atomic Agent.");
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(state);
    // Review fix: the exchange below takes up to a couple of seconds; a poll
    // in that window must read "pending", not "signed_out" (which the window
    // took as a failed sign-in).
    this.exchanging.add(entry.server);
    try {
      await this.finishCallback(reqUrl, entry, res);
    } finally {
      this.exchanging.delete(entry.server);
      this.closeListenerIfIdle();
    }
  }

  private async finishCallback(reqUrl: URL, entry: PendingSignIn, res: ServerResponse): Promise<void> {
    const refused = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");
    let failure: string | null = null;
    if (refused) {
      const why = reqUrl.searchParams.get("error_description") ?? refused;
      failure = `Sign-in was not completed: ${why.slice(0, 200)}`;
    } else if (!code) {
      failure = "The browser came back without a sign-in code.";
    } else {
      try {
        const result = await this.authorize(entry.provider, {
          serverUrl: entry.url,
          authorizationCode: code,
        });
        if (result !== "AUTHORIZED") failure = "The server did not accept the sign-in.";
      } catch (err) {
        failure = `The server did not accept the sign-in: ${scrubErrorMessage(err)}`;
      }
    }

    if (failure) {
      this.lastErrors.set(entry.server, failure);
      this.deps.logger?.warn("mcp.oauth_callback_failed", { server: entry.server });
      sendPage(res, 400, `${failure} You can close this tab and try again from Atomic Agent.`);
      this.closeListenerIfIdle();
      return;
    }
    this.lastErrors.delete(entry.server);
    this.deps.logger?.info("mcp.oauth_signed_in", { server: entry.server });
    sendPage(res, 200, "You are signed in. You can close this tab and return to Atomic Agent.");
    this.closeListenerIfIdle();
    await this.reconnectQuietly(entry.server);
  }

  private async ensureListener(): Promise<number> {
    if (this.listener && this.listenerPort !== null) return this.listenerPort;
    if (!this.listening) {
      this.listening = this.openListener().finally(() => {
        this.listening = null;
      });
    }
    return this.listening;
  }

  private async openListener(): Promise<number> {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      this.handleCallback(req, res).catch(() => {
        if (!res.headersSent) sendPage(res, 500, "Something went wrong. Start sign-in again from Atomic Agent.");
      });
    };
    for (const port of this.deps.ports ?? MCP_OAUTH_PORTS) {
      try {
        const server = await listenOn(port, handler);
        this.listener = server;
        this.listenerPort = (server.address() as AddressInfo).port;
        return this.listenerPort;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === "EADDRINUSE" || code === "EACCES") continue;
        throw new McpOAuthFlowError("failed", `Could not open a local port for sign-in: ${scrubErrorMessage(err)}`);
      }
    }
    throw new McpOAuthFlowError("failed", "Could not open a local port for sign-in.");
  }

  private closeListenerIfIdle(): void {
    if (this.pending.size === 0 && this.starting === 0 && this.exchanging.size === 0) void this.closeListener();
  }

  private async closeListener(): Promise<void> {
    const server = this.listener;
    this.listener = null;
    this.listenerPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  }
}

function notFound(name: string): McpOAuthFlowError {
  return new McpOAuthFlowError("not_found", `There is no MCP server named ${JSON.stringify(name)}.`);
}

function listenOn(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    const onError = (err: Error): void => {
      server.close();
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, MCP_OAUTH_CALLBACK_HOST, () => {
      server.off("error", onError);
      // A sign-in in progress must not keep a stopping agent alive.
      server.unref();
      resolve(server);
    });
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendPage(res: ServerResponse, status: number, message: string): void {
  const body =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Atomic Agent</title>" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5\">" +
    `<p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}
