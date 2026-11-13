import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { McpClient, clientCapabilities } from "./mcp-client.js";
import {
  createMcpElicitationHandler,
  type McpElicitationPort,
  type McpElicitationReply,
} from "./mcp-elicitation-handler.js";
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
      elicitationHandler: createMcpElicitationHandler({ port: { surface: "interactive", ask }, server: "demo-elicit" }),
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
        port: { surface: "interactive", ask: async () => ({ action: "unavailable" as const }) },
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

// An in-process server on an in-memory transport, so fake timers can
// drive the 60 s tool-call deadline. `ask` sends one
// `elicitation/create` and answers the call with the client's result;
// `hang` never answers. With `answerCall: false`, `ask` never answers
// the call either, even after the person has.
function fakeServer({ answerCall = true } = {}): { transport: InMemoryTransport; cancelled: unknown[] } {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const cancelled: unknown[] = [];
  let pendingCall: string | number | null = null;
  const send = (m: unknown) => void serverSide.send(m as JSONRPCMessage);
  const text = (id: string | number, value: unknown) =>
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  serverSide.onmessage = (raw) => {
    const m = raw as {
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    };
    if (m.method === "notifications/cancelled") cancelled.push(m.params?.requestId);
    if (m.id === undefined) return;
    if (m.method === undefined) {
      if (m.id === "e1" && pendingCall !== null && answerCall) text(pendingCall, m.result ?? { error: m.error });
      return;
    }
    if (m.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      });
    } else if (m.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          tools: [
            { name: "ask", inputSchema: { type: "object" } },
            { name: "hang", inputSchema: { type: "object" } },
          ],
        },
      });
    } else if (m.method === "tools/call" && m.params?.name === "ask") {
      pendingCall = m.id;
      send({
        jsonrpc: "2.0",
        id: "e1",
        method: "elicitation/create",
        params: {
          message: "Which account?",
          requestedSchema: {
            type: "object",
            properties: { account: { type: "string", enum: ["work", "home"] } },
            required: ["account"],
          },
        },
      });
    } else if (m.method === "tools/call" && m.params?.name === "hang") {
      // never answers
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
  };
  void serverSide.start();
  return { transport: clientSide, cancelled };
}

const FAKE_CONFIG = {
  name: "fake",
  enabled: true,
  transport: { kind: "stdio", command: "unused" },
} as McpServerConfig;

async function connectFake(port: McpElicitationPort, opts?: { answerCall?: boolean }) {
  const server = fakeServer(opts);
  const client = new McpClient(FAKE_CONFIG, {
    transportFactory: () => server.transport,
    elicitationHandler: createMcpElicitationHandler({ port, server: "fake" }),
  });
  await client.connect();
  return { client, server };
}

/** Settle state of a promise without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { value?: T; error?: unknown } = {};
  p.then(
    (v) => (state.value = v),
    (e) => (state.error = e),
  );
  return state;
}

describe("McpClient tool-call deadline during elicitation (ATO-704)", () => {
  it("keeps the call alive while the person answers after 61 s, and returns the server's result", async () => {
    const answer: McpElicitationReply = { action: "accept", content: { account: "home" } };
    const port: McpElicitationPort = {
      surface: "interactive",
      ask: () => new Promise((resolve) => setTimeout(() => resolve(answer), 61_000)),
    };
    const { client } = await connectFake(port);
    vi.useFakeTimers();
    try {
      const call = client.callTool("ask", {}, new AbortController().signal);
      const state = track(call);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(state.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      const res = await call;
      const content = res.content as Array<{ text: string }>;
      expect(JSON.parse(content[0].text)).toMatchObject({ action: "accept", content: { account: "home" } });
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("still times out at 60 s when no elicitation is pending, and tells the server", async () => {
    const port: McpElicitationPort = { surface: "interactive", ask: async () => ({ action: "decline" }) };
    const { client, server } = await connectFake(port);
    vi.useFakeTimers();
    try {
      const state = track(client.callTool("hang", {}, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(String((state.error as Error | undefined)?.message)).toContain("tool call timeout after 60000ms");
      expect(server.cancelled.length).toBe(1);
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("gives the call a fresh 60 s window once the person has answered", async () => {
    // The server gets the answer after 10 minutes but never replies to the call.
    const port: McpElicitationPort = {
      surface: "interactive",
      ask: () =>
        new Promise((resolve) => setTimeout(() => resolve({ action: "decline" }), 10 * 60_000)),
    };
    const { client } = await connectFake(port, { answerCall: false });
    vi.useFakeTimers();
    try {
      const state = track(client.callTool("ask", {}, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(state.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(String((state.error as Error | undefined)?.message)).toContain("tool call timeout after 60000ms");
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("ends an open-ended interactive wait when the client closes", async () => {
    let seen: AbortSignal | undefined;
    const port: McpElicitationPort = {
      surface: "interactive",
      ask: (_q, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
    };
    const { client } = await connectFake(port);
    const state = track(client.callTool("ask", {}, new AbortController().signal));
    await vi.waitFor(() => expect(seen).toBeDefined());
    await client.close();
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
    await vi.waitFor(() => expect(state.error).toBeDefined());
  });
});
