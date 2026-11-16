import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpClient } from "./mcp-client.js";
import { McpAuthRequiredError, McpConnectError } from "./mcp-errors.js";
import { createMcpOAuthStore } from "./mcp-oauth-store.js";
import type { McpServerConfig } from "./mcp-types.js";

/**
 * A remote MCP server that only accepts OAuth: every MCP request gets a
 * 401 with `resource_metadata`, and the discovery and registration
 * endpoints answer the way a real authorization server does.
 */
async function startOAuthOnlyServer(): Promise<{
  server: Server;
  base: string;
  seenAuthHeaders: Array<string | undefined>;
  registrations: number;
}> {
  const state = { seenAuthHeaders: [] as Array<string | undefined>, registrations: 0 };
  let base = "";
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", base).pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (path === "/register" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        state.registrations += 1;
        json(res, 201, { ...(JSON.parse(body) as object), client_id: "client-1" });
      });
      return;
    }
    if (path === "/plain") {
      // A keyless server that wants something other than OAuth.
      req.resume();
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("missing key");
      return;
    }
    if (path === "/mcp") {
      state.seenAuthHeaders.push(req.headers.authorization);
      req.resume();
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    base,
    get seenAuthHeaders() {
      return state.seenAuthHeaders;
    },
    get registrations() {
      return state.registrations;
    },
  };
}

describe("McpClient OAuth", () => {
  let stateDir: string;
  let fixture: Awaited<ReturnType<typeof startOAuthOnlyServer>>;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mcp-client-oauth-"));
    fixture = await startOAuthOnlyServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  });

  function config(headers?: Record<string, string>): McpServerConfig {
    return {
      name: "monid",
      enabled: true,
      transport: {
        kind: "streamable_http",
        url: `${fixture.base}/mcp`,
        ...(headers ? { headers } : {}),
      },
    };
  }

  it("a 401 from an OAuth-only server becomes a sign-in request", async () => {
    const client = new McpClient(config(), { oauthStateDir: stateDir });
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthRequiredError);
    expect((err as Error).message).toBe("Sign in required");
    // A connect with no saved sign-in registers nothing and stores nothing:
    // only the user's Sign in does that.
    const rec = createMcpOAuthStore(stateDir).load("monid", `${fixture.base}/mcp`);
    expect(rec.clientInformation).toBeUndefined();
    expect(rec.codeVerifier).toBeUndefined();
    expect(rec.pendingAuthUrl).toBeUndefined();
    expect(fixture.registrations).toBe(0);
  });

  it("a 401 from a server with no OAuth metadata keeps its own error", async () => {
    const client = new McpClient(
      { ...config(), transport: { kind: "streamable_http", url: `${fixture.base}/plain` } },
      { oauthStateDir: stateDir },
    );
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectError);
    expect(err).not.toBeInstanceOf(McpAuthRequiredError);
    expect(fixture.registrations).toBe(0);
  });

  it("sends the saved access token", async () => {
    createMcpOAuthStore(stateDir).update("monid", `${fixture.base}/mcp`, {
      tokens: { access_token: "saved-token", token_type: "Bearer" },
    });
    const client = new McpClient(config(), { oauthStateDir: stateDir });
    await client.connect().catch(() => {});
    expect(fixture.seenAuthHeaders[0]).toBe("Bearer saved-token");
  });

  it("a server with an Authorization header gets no provider", async () => {
    const client = new McpClient(config({ Authorization: "Bearer static" }), {
      oauthStateDir: stateDir,
    });
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectError);
    expect(err).not.toBeInstanceOf(McpAuthRequiredError);
    expect(fixture.seenAuthHeaders[0]).toBe("Bearer static");
    expect(fixture.registrations).toBe(0);
  });

  it("without a state dir nothing changes", async () => {
    const client = new McpClient(config(), {});
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(McpAuthRequiredError);
    expect(fixture.registrations).toBe(0);
  });
});
