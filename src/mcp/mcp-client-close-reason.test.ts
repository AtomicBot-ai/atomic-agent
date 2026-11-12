import { describe, expect, it } from "vitest";

import { McpClient } from "./mcp-client.js";
import { McpRequestError } from "./mcp-errors.js";
import type { McpServerConfig } from "./mcp-types.js";

// A real stdio child speaking just enough MCP: it answers the handshake
// and the tool list, and never answers a tool call.
const HANGING_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "hang", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "wait", inputSchema: { type: "object" } }] } });
  else if (m.method !== "tools/call") send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

function hangingServer(): McpServerConfig {
  return {
    name: "demo-local",
    enabled: true,
    transport: { kind: "stdio", command: process.execPath, args: ["-e", HANGING_SERVER] },
  } as McpServerConfig;
}

describe("McpClient close reason (ATO-1407)", () => {
  it("ends a call still waiting on the server with the reason it was closed for", async () => {
    const client = new McpClient(hangingServer());
    await client.connect();
    const call = client.callTool("wait", {}, new AbortController().signal);
    const settled = call.then(() => null, (err: unknown) => err);
    await new Promise((r) => setTimeout(r, 100));
    await client.close("plugin demo no longer allows this server");
    const err = await settled;
    expect(err).toBeInstanceOf(McpRequestError);
    expect((err as Error).message).toContain("plugin demo no longer allows this server");
    expect(client.isConnected).toBe(false);
  }, 20_000);

  it("forgets the reason on the next connect", async () => {
    const client = new McpClient(hangingServer());
    await client.connect();
    await client.close("stopped");
    await client.connect();
    const call = client.callTool("wait", {}, new AbortController().signal, 300);
    await expect(call).rejects.toThrow(/timeout/);
    await client.close();
  }, 20_000);
});
