import { describe, expect, it } from "vitest";

import { ApprovalGate, describeMcpToolGrant } from "../approval/approval-gate.js";
import type { ToolContext } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import { createMcpToolDefinition, mcpGrantKey } from "./mcp-tool-adapter.js";
import type { McpToolMeta } from "./mcp-types.js";

// ATO-1473: "Allow in this chat" on one MCP server's prompt used to
// record a whole-category grant for `other`, the category every MCP tool
// shares, so every other plugin's tools stopped asking for the rest of
// the chat. The grant is now keyed by the server and the tool.

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
  it("covers the one tool it was given on, not the server's other tools", async () => {
    const { gate, asked } = grantingGate();
    const ctx = ctxFor("s");

    await toolOf(gate, "github", "create_issue").run({}, ctx);
    expect(asked).toEqual(["mcp.github.create_issue"]);
    // Not a whole-category grant any more.
    expect(gate.sessionGrants("s").categories).toEqual([]);

    // Same tool: silent.
    await toolOf(gate, "github", "create_issue").run({}, ctx);
    expect(asked).toHaveLength(1);

    // Another tool of the same server: asks.
    await toolOf(gate, "github", "close_issue").run({}, ctx);
    expect(asked).toEqual(["mcp.github.create_issue", "mcp.github.close_issue"]);
  });

  it("does not cover another server's tools, even one with the same name", async () => {
    const { gate, asked } = grantingGate();
    const ctx = ctxFor("s");
    await toolOf(gate, "github", "create_issue").run({}, ctx);
    const other = await toolOf(gate, "linear", "save_issue").run({}, ctx);
    expect(other.status).toBe("ok");
    await toolOf(gate, "gitlab", "create_issue").run({}, ctx);
    expect(asked).toEqual([
      "mcp.github.create_issue",
      "mcp.linear.save_issue",
      "mcp.gitlab.create_issue",
    ]);
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

  it("keys by server and tool, and the prompt names both", () => {
    expect(mcpGrantKey("github", "create_issue")).toBe("MCP tool github/create_issue");
    expect(
      describeMcpToolGrant({
        approvalId: "a",
        sessionId: "s",
        tool: "mcp.github.create_issue",
        category: "other",
        reason: "r",
        grantKey: mcpGrantKey("github", "create_issue"),
      }),
    ).toBe("create_issue from MCP server github");
    // Any other key (an HTTP origin) is not an MCP tool grant.
    expect(
      describeMcpToolGrant({
        approvalId: "a",
        sessionId: "s",
        tool: "os.http.request",
        category: "http",
        reason: "r",
        grantKey: "https://a.example",
      }),
    ).toBeNull();
  });
});
