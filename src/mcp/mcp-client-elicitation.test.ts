import { describe, expect, it, vi } from "vitest";

import { McpClient, clientCapabilities } from "./mcp-client.js";
import { createMcpElicitationHandler } from "./mcp-elicitation-handler.js";
import type { McpServerConfig } from "./mcp-types.js";

// A real stdio child speaking just enough MCP. `caps` returns the
// capabilities the client advertised in `initialize`; `ask` sends one
// `elicitation/create` back to the client and returns its result.
const ELICITING_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let caps = {};
let pendingCall = null;
const text = (id, value) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === undefined) {
    if (m.id === "e1" && pendingCall !== null) text(pendingCall, m.result ?? { error: m.error });
    return;
  }
  if (m.method === "initialize") {
    caps = m.params.capabilities ?? {};
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "elicit", version: "1" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "caps", inputSchema: { type: "object" } }, { name: "ask", inputSchema: { type: "object" } }] } });
  } else if (m.method === "tools/call" && m.params.name === "caps") {
    text(m.id, caps);
  } else if (m.method === "tools/call" && m.params.name === "ask") {
    pendingCall = m.id;
    send({ jsonrpc: "2.0", id: "e1", method: "elicitation/create", params: {
      message: "Which account?",
      requestedSchema: { type: "object", properties: { account: { type: "string", enum: ["work", "home"] } }, required: ["account"] },
    } });
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  }
});
`;

function elicitingServer(): McpServerConfig {
  return {
    name: "demo-elicit",
    enabled: true,
    transport: { kind: "stdio", command: process.execPath, args: ["-e", ELICITING_SERVER] },
  } as McpServerConfig;
}

async function callText(client: McpClient, tool: string): Promise<unknown> {
  const res = await client.callTool(tool, {}, new AbortController().signal, 10_000);
  const content = res.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
}

describe("clientCapabilities", () => {
  it("advertises elicitation only when a handler is wired", () => {
    expect(clientCapabilities({})).toEqual({});
    const elicitationHandler = vi.fn();
    expect(clientCapabilities({ elicitationHandler })).toEqual({ elicitation: {} });
  });
});

describe("McpClient elicitation (ATO-704)", () => {
  it("does not advertise elicitation without a handler", async () => {
    const client = new McpClient(elicitingServer());
    await client.connect();
    try {
      expect(await callText(client, "caps")).not.toHaveProperty("elicitation");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("advertises elicitation with a handler and returns the person's answer to the server", async () => {
    const ask = vi.fn(async () => ({ action: "accept" as const, content: { account: "home" } }));
    const client = new McpClient(elicitingServer(), {
      elicitationHandler: createMcpElicitationHandler({ port: { ask }, server: "demo-elicit" }),
    });
    await client.connect();
    try {
      expect(await callText(client, "caps")).toHaveProperty("elicitation");
      expect(await callText(client, "ask")).toMatchObject({
        action: "accept",
        content: { account: "home" },
      });
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("sends decline when nobody can answer, and the tool call still completes", async () => {
    const client = new McpClient(elicitingServer(), {
      elicitationHandler: createMcpElicitationHandler({
        port: { ask: async () => ({ action: "unavailable" as const }) },
        server: "demo-elicit",
      }),
    });
    await client.connect();
    try {
      expect(await callText(client, "ask")).toMatchObject({ action: "decline" });
    } finally {
      await client.close();
    }
  }, 20_000);
});
