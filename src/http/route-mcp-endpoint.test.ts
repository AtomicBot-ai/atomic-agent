import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const KEY = "mcp-http-test-key-0123456789";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "0.0.0" },
  },
};

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("POST/GET/DELETE /mcp (ATO-549)", () => {
  let harness: Harness | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    await harness?.cleanup();
    harness = null;
  });

  async function connect(h: Harness, apiKey?: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
      ...(apiKey ? { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } } : {}),
    });
    const c = new Client({ name: "atomic-agent-test", version: "0.0.0" });
    await c.connect(transport);
    return { client: c, transport };
  }

  it("initializes a session with the official SDK client and lists the read-only tools", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    const connected = await connect(harness, KEY);
    client = connected.client;

    expect(connected.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.getServerVersion()?.name).toBe("atomic-agent");

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("skills_list");
    expect(names).toContain("skill_view");
    // Writes and the shell stay on `atomic-agent mcp-server` only.
    expect(names).not.toContain("os_shell_run");
    expect(names).not.toContain("memory_notes_store");
    expect(names).not.toContain("memory_profile_set");
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("runs tools/call through the agent's tool registry", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    client = (await connect(harness, KEY)).client;

    const result = await client.callTool({ name: "skills_list", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(typeof content[0]?.text).toBe("string");

    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
  });

  it("works keyless on loopback, like the other routes", async () => {
    harness = await startTestHarness();
    client = (await connect(harness)).client;
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("refuses a request without the API key", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const wrong = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer wrong-key-wrong-key-00" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(wrong.status).toBe(401);
  });

  it("refuses a foreign Origin even with a valid key (DNS rebinding)", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY}`, origin: "https://evil.example" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe("2.0");
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const local = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY}`, origin: "http://localhost:3000" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(local.status).toBe(200);
    expect(local.headers.get("mcp-session-id")).toBeTruthy();
    await local.body?.cancel();
  });

  it("refuses a foreign Origin without a key too", async () => {
    harness = await startTestHarness();
    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "https://evil.example" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(403);
  });

  it("answers 400 without a session id, 404 for an unknown one, and ends a session on DELETE", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    const auth = { authorization: `Bearer ${KEY}` };
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

    const noSession = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...auth },
      body: JSON.stringify(list),
    });
    expect(noSession.status).toBe(400);

    const unknown = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...auth, "mcp-session-id": "not-a-session" },
      body: JSON.stringify(list),
    });
    expect(unknown.status).toBe(404);

    const connected = await connect(harness, KEY);
    const sessionId = connected.transport.sessionId!;
    await connected.transport.terminateSession();
    await connected.client.close();

    const after = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...auth, "mcp-session-id": sessionId },
      body: JSON.stringify(list),
    });
    expect(after.status).toBe(404);
  });
});
