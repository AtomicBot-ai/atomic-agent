import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpServerConfig } from "../mcp/mcp-types.js";

import { startTestHarness, type Harness } from "./test-harness.js";

// A stdio command that cannot spawn: enabling it lands in `down`
// without a real MCP server, which is all these routes need.
const DOCS: McpServerConfig = {
  name: "docs",
  enabled: false,
  transport: { kind: "stdio", command: "/nonexistent/atomic-mcp-test" },
};

function persistedEnabled(harness: Harness): boolean | undefined {
  const file = JSON.parse(
    readFileSync(join(harness.stateDir, "config.json"), "utf8"),
  ) as { mcp: { servers: McpServerConfig[] } };
  return file.mcp.servers.find((s) => s.name === "docs")?.enabled;
}

function post(harness: Harness, path: string, token?: string) {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("/api/mcp/servers/{name}", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("enable persists the flag and connects the server live", async () => {
    harness = await startTestHarness({ mcpServers: [DOCS] });
    const spy = vi.spyOn(harness.runtime.mcpManager, "setServerEnabled");
    const res = await post(harness, "/api/mcp/servers/docs/enable");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { server: { state: string } };
    expect(spy).toHaveBeenCalledWith("docs", true);
    expect(body.server.state).toBe("down");
    expect(persistedEnabled(harness)).toBe(true);
  });

  it("disable persists the flag and stops the server live", async () => {
    harness = await startTestHarness({
      mcpServers: [{ ...DOCS, enabled: true }],
    });
    const res = await post(harness, "/api/mcp/servers/docs/disable");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { server: { state: string } };
    expect(body.server.state).toBe("disabled");
    expect(persistedEnabled(harness)).toBe(false);
  });

  it("restart restarts the live server and leaves config alone", async () => {
    harness = await startTestHarness({ mcpServers: [DOCS] });
    const spy = vi.spyOn(harness.runtime.mcpManager, "restartServer");
    const res = await post(harness, "/api/mcp/servers/docs/restart");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith("docs");
    expect(persistedEnabled(harness)).toBe(false);
  });

  it("returns 404 for a server that is not configured", async () => {
    harness = await startTestHarness({ mcpServers: [DOCS] });
    for (const op of ["restart", "enable", "disable"]) {
      const res = await post(harness, `/api/mcp/servers/nope/${op}`);
      expect(res.status).toBe(404);
    }
  });

  it("requires the bearer token like the other /api routes", async () => {
    harness = await startTestHarness({ apiKey: "secret", mcpServers: [DOCS] });
    const spy = vi.spyOn(harness.runtime.mcpManager, "restartServer");
    const denied = await post(harness, "/api/mcp/servers/docs/restart");
    expect(denied.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    const allowed = await post(
      harness,
      "/api/mcp/servers/docs/restart",
      "secret",
    );
    expect(allowed.status).toBe(200);
  });
});

// Port 9 (discard) refuses connections: the server lands in `down`
// quickly without any network, which is all the sign-in routes need.
const REMOTE: McpServerConfig = {
  name: "remote",
  enabled: false,
  transport: { kind: "streamable_http", url: "http://127.0.0.1:9/mcp" },
};
const KEYED: McpServerConfig = {
  name: "keyed",
  enabled: false,
  transport: {
    kind: "streamable_http",
    url: "http://127.0.0.1:9/mcp",
    headers: { Authorization: "Bearer k" },
  },
};

describe("/api/mcp/servers/{name}/auth", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("status reads signed_out, then signed_in once a token is saved", async () => {
    harness = await startTestHarness({ mcpServers: [REMOTE] });
    const res = await fetch(`${harness.baseUrl}/api/mcp/servers/remote/auth`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "signed_out" });

    const { createMcpOAuthStore } = await import("../mcp/mcp-oauth-store.js");
    createMcpOAuthStore(harness.stateDir).update("remote", "http://127.0.0.1:9/mcp", {
      tokens: { access_token: "tok" },
    });
    const after = await fetch(`${harness.baseUrl}/api/mcp/servers/remote/auth`);
    expect(await after.json()).toEqual({ state: "signed_in" });
  });

  it("signout deletes the saved sign-in and restarts the server", async () => {
    harness = await startTestHarness({ mcpServers: [REMOTE] });
    const { createMcpOAuthStore, mcpOAuthFilePath } = await import("../mcp/mcp-oauth-store.js");
    createMcpOAuthStore(harness.stateDir).update("remote", "http://127.0.0.1:9/mcp", {
      tokens: { access_token: "tok" },
    });
    const spy = vi.spyOn(harness.runtime.mcpManager, "restartServer");
    const res = await post(harness, "/api/mcp/servers/remote/auth/signout");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "signed_out" });
    expect(spy).toHaveBeenCalledWith("remote");
    const { existsSync } = await import("node:fs");
    expect(existsSync(mcpOAuthFilePath(harness.stateDir, "remote"))).toBe(false);
  });

  it("start refuses a stdio server, a keyed server and an unknown name", async () => {
    harness = await startTestHarness({ mcpServers: [DOCS, KEYED] });
    const local = await post(harness, "/api/mcp/servers/docs/auth/start");
    expect(local.status).toBe(409);
    const localBody = (await local.json()) as { error: { code: string; message: string } };
    expect(localBody.error.code).toBe("mcp_auth_not_remote");
    expect(localBody.error.message).toMatch(/no browser sign-in/);

    const keyed = await post(harness, "/api/mcp/servers/keyed/auth/start");
    expect(keyed.status).toBe(409);
    expect(((await keyed.json()) as { error: { code: string } }).error.code).toBe("mcp_auth_uses_key");

    const missing = await post(harness, "/api/mcp/servers/nope/auth/start");
    expect(missing.status).toBe(404);
    const status = await fetch(`${harness.baseUrl}/api/mcp/servers/nope/auth`);
    expect(status.status).toBe(404);
  });

  it("start on an unreachable server answers with a plain error", async () => {
    harness = await startTestHarness({ mcpServers: [REMOTE] });
    const res = await post(harness, "/api/mcp/servers/remote/auth/start");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/^Could not start sign-in/);
  });
});
