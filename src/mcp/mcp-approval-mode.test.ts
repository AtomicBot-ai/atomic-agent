import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate, ApprovalRequest } from "../approval/approval-gate.js";
import type { ToolContext } from "../tools/tool-registry.js";

import { mcpToolPrompts, modeSkipsDefaultPrompt } from "./mcp-approval-mode.js";
import type { McpClient } from "./mcp-client.js";
import { createMcpToolDefinition } from "./mcp-tool-adapter.js";
import type { McpApprovalMode, McpToolMeta, McpTrustLevel } from "./mcp-types.js";

// ATO-1134: a per-server `approval` mode decides whether that server's
// tools ask; absent, the answer is exactly the old one.

function inputs(
  trust: McpTrustLevel,
  approval: McpApprovalMode | undefined,
  readOnlyHint: boolean,
  trustReadOnlyHint: boolean,
) {
  return {
    trust,
    ...(approval !== undefined ? { approval } : {}),
    readOnlyHint,
    trustReadOnlyHint,
  };
}

describe("mcpToolPrompts", () => {
  it("without a mode keeps the old answer for every combination", () => {
    for (const ro of [true, false]) {
      for (const trusted of [true, false]) {
        expect(mcpToolPrompts(inputs("approval_gated", undefined, ro, trusted))).toBe(
          !(ro && trusted),
        );
        expect(mcpToolPrompts(inputs("pure_read", undefined, ro, trusted))).toBe(false);
      }
    }
  });

  it("ask: the approval_gated answer, also on a pure_read server", () => {
    for (const trust of ["approval_gated", "pure_read"] as const) {
      expect(mcpToolPrompts(inputs(trust, "ask", false, true))).toBe(true);
      expect(mcpToolPrompts(inputs(trust, "ask", true, false))).toBe(true);
      expect(mcpToolPrompts(inputs(trust, "ask", true, true))).toBe(false);
    }
  });

  it("ask_writes: a read-only-hinted tool runs unasked on any transport, others ask", () => {
    expect(mcpToolPrompts(inputs("approval_gated", "ask_writes", true, false))).toBe(false);
    expect(mcpToolPrompts(inputs("approval_gated", "ask_writes", false, true))).toBe(true);
    expect(mcpToolPrompts(inputs("pure_read", "ask_writes", false, false))).toBe(true);
  });

  it("auto: never asks", () => {
    expect(mcpToolPrompts(inputs("approval_gated", "auto", false, false))).toBe(false);
  });

  it("modeSkipsDefaultPrompt is true only where the mode loosened the default", () => {
    expect(modeSkipsDefaultPrompt(inputs("approval_gated", undefined, false, false))).toBe(false);
    expect(modeSkipsDefaultPrompt(inputs("approval_gated", "auto", false, false))).toBe(true);
    expect(modeSkipsDefaultPrompt(inputs("approval_gated", "ask_writes", true, false))).toBe(true);
    // Already unasked by default: the mode changed nothing.
    expect(modeSkipsDefaultPrompt(inputs("pure_read", "auto", false, false))).toBe(false);
    expect(modeSkipsDefaultPrompt(inputs("approval_gated", "auto", true, true))).toBe(false);
    // Stricter modes never count.
    expect(modeSkipsDefaultPrompt(inputs("pure_read", "ask", false, false))).toBe(false);
  });
});

describe("createMcpToolDefinition with an approval mode", () => {
  const ctx: ToolContext = {
    workingDir: "/tmp",
    sessionId: "s-test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };

  function meta(rawName: string, readOnlyHint?: boolean): McpToolMeta {
    return {
      server: "remote",
      rawName,
      qualifiedName: `mcp.remote.${rawName}`,
      description: "",
      inputSchema: { type: "object" },
      resourceClass: "approval_gated",
      ...(readOnlyHint !== undefined ? { annotations: { readOnlyHint } } : {}),
    };
  }

  function harness(rule: "allow" | "ask" | "deny" | null = null) {
    const requests: Omit<ApprovalRequest, "approvalId">[] = [];
    const approvals = {
      request: async (req: Omit<ApprovalRequest, "approvalId">) => {
        requests.push(req);
        return { approvalId: "a", approved: true };
      },
      ruleDecisionFor: vi.fn(() => rule),
    } as unknown as ApprovalGate;
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = (m: McpToolMeta, approval?: McpApprovalMode, trust: McpTrustLevel = "approval_gated") =>
      createMcpToolDefinition(m, { callTool } as unknown as McpClient, {
        trust,
        dangerous: { approvals, approvalRequired: true },
        ...(approval !== undefined ? { approval } : {}),
      });
    return { requests, tool, callTool };
  }

  it("auto lets a remote write tool run unasked", async () => {
    const h = harness();
    const result = await h.tool(meta("create_issue"), "auto").run({}, ctx);
    expect(result.status).toBe("ok");
    expect(h.requests).toHaveLength(0);
    expect(h.callTool).toHaveBeenCalledTimes(1);
  });

  it("ask_writes: a read-only remote tool runs unasked, a write tool asks", async () => {
    const h = harness();
    await h.tool(meta("search", true), "ask_writes").run({}, ctx);
    expect(h.requests).toHaveLength(0);
    await h.tool(meta("create_issue"), "ask_writes").run({}, ctx);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ tool: "mcp.remote.create_issue", category: "other" });
  });

  it("ask on a pure_read server asks again", async () => {
    const h = harness();
    await h.tool(meta("create_issue"), "ask", "pure_read").run({}, ctx);
    expect(h.requests).toHaveLength(1);
  });

  it("a saved deny or ask rule still sends a call auto let through to the gate", async () => {
    for (const rule of ["deny", "ask"] as const) {
      const h = harness(rule);
      await h.tool(meta("create_issue"), "auto").run({}, ctx);
      expect(h.requests).toHaveLength(1);
    }
    const allow = harness("allow");
    await allow.tool(meta("create_issue"), "auto").run({}, ctx);
    expect(allow.requests).toHaveLength(0);
  });

  it("without a mode a remote read-only tool still asks (ATO-1178 unchanged)", async () => {
    const h = harness();
    await h.tool(meta("search", true)).run({}, ctx);
    expect(h.requests).toHaveLength(1);
  });
});
