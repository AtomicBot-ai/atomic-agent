import { describe, expect, it } from "vitest";

import { ApprovalGate } from "../approval/approval-gate.js";
import type { ToolContext } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import { createMcpToolDefinition, mcpGrantKey } from "./mcp-tool-adapter.js";
import type { McpToolMeta } from "./mcp-types.js";

// ATO-1473: "Allow in this chat" on one MCP server's prompt used to
// record a whole-category grant for `other`, the category every MCP tool
// shares, so every other plugin's tools stopped asking for the rest of
// the chat. The grant is now keyed by the server.

function metaOf(server: string, rawName: string): McpToolMeta {
  return {
    server,
    rawName,
    qualifiedName: `mcp.${server}.${rawName}`,
    description: "",
    inputSchema: { type: "object" },
    resourceClass: "approval_gated",
  };
}

const client = {
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
} as unknown as McpClient;

function ctxFor(sessionId: string): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

/** A real gate whose every prompt is answered "Allow in this chat". */
function grantingGate(): { gate: ApprovalGate; asked: string[] } {
  const asked: string[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    emit: (req) => {
      asked.push(req.tool);
      setImmediate(() =>
        gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }),
      );
    },
  });
  return { gate, asked };
}

function toolOf(gate: ApprovalGate, server: string, rawName: string) {
  return createMcpToolDefinition(metaOf(server, rawName), client, {
    trust: "approval_gated",
    dangerous: { approvals: gate, approvalRequired: true },
  });
}

describe("MCP 'Allow in this chat' scope (ATO-1473)", () => {
  it("covers the server it was given on, not other servers' tools", async () => {
    const { gate, asked } = grantingGate();
    const ctx = ctxFor("s");

    await toolOf(gate, "github", "create_issue").run({}, ctx);
    expect(asked).toEqual(["mcp.github.create_issue"]);
    // Not a whole-category grant any more.
    expect(gate.sessionGrants("s").categories).toEqual([]);

    // Same server, same or another tool: silent.
    await toolOf(gate, "github", "create_issue").run({}, ctx);
    await toolOf(gate, "github", "close_issue").run({}, ctx);
    expect(asked).toHaveLength(1);

    // Another server: asks.
    const other = await toolOf(gate, "linear", "save_issue").run({}, ctx);
    expect(other.status).toBe("ok");
    expect(asked).toEqual(["mcp.github.create_issue", "mcp.linear.save_issue"]);
  });

  it("does not leak into another chat", async () => {
    const { gate, asked } = grantingGate();
    await toolOf(gate, "github", "create_issue").run({}, ctxFor("a"));
    await toolOf(gate, "github", "create_issue").run({}, ctxFor("b"));
    expect(asked).toHaveLength(2);
  });

  it("an older whole-category `other` grant does not answer an MCP tool", async () => {
    const { gate, asked } = grantingGate();
    await gate.request({ sessionId: "s", tool: "x", category: "other", reason: "r" });
    expect(gate.sessionGrants("s").categories).toEqual(["other"]);
    await toolOf(gate, "github", "create_issue").run({}, ctxFor("s"));
    expect(asked).toEqual(["x", "mcp.github.create_issue"]);
  });

  it("keys by server name", () => {
    expect(mcpGrantKey("github")).toBe("MCP server github");
    expect(mcpGrantKey("github")).not.toBe(mcpGrantKey("linear"));
  });
});
