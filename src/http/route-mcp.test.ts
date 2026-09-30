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
