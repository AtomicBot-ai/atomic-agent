/**
 * The MCP protocol side of `atomic-agent mcp-server` (ATO-549): lists
 * the selected tools and runs a call through the same `ToolRegistry`
 * the agent uses, so secret masking and untrusted-output framing apply
 * here too. Transport-free: the command connects stdio, tests connect
 * an in-memory pair.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { runWithApprovalWorkdir } from "../approval/approval-workdir.js";
import type { McpServeToolSet } from "./mcp-server-tools.js";

/** Session id every call runs under; the gate's refuse policy is keyed on it. */
export const MCP_SERVE_SESSION_ID = "mcp-server";

/**
 * What a gated request that would prompt gets back. The model on the
 * other side reads it, so it says what to do instead.
 */
export const MCP_SERVE_REFUSAL =
  "this action needs an approval, and an MCP client cannot show the Atomic Agent approval prompt. " +
  "Ask the user to run it themselves, or to allow it with a saved rule or a higher approval level in Atomic Agent";

export interface McpServeBridgeOptions {
  toolSet: McpServeToolSet;
  workingDir: string;
  version: string;
  sessionId?: string;
}

export function createMcpServeServer(options: McpServeBridgeOptions): McpServer {
  const { toolSet, workingDir } = options;
  const sessionId = options.sessionId ?? MCP_SERVE_SESSION_ID;
  const server = new McpServer(
    { name: "atomic-agent", version: options.version },
    { capabilities: { tools: {} } },
  );
  let step = 0;

  // Raw handlers on the protocol server: our tools carry JSON Schemas,
  // and `McpServer.registerTool` only takes zod shapes.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolSet.tools.map((t) => ({
      name: t.wireName,
      description: t.definition.description,
      inputSchema: t.inputSchema as { type: "object"; [key: string]: unknown },
      annotations: { readOnlyHint: t.definition.readonly },
    })),
  }));

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const name = toolSet.byWireName.get(request.params.name);
      if (name === undefined) {
        return errorResult(`unknown tool: ${request.params.name}`);
      }
      const args = request.params.arguments ?? {};
      try {
        const result = await runWithApprovalWorkdir(workingDir, () =>
          toolSet.registry.invoke(name, args, {
            workingDir,
            sessionId,
            stepIndex: step++,
            signal: extra.signal,
            // A client gets whole notes and skill bodies, as a cloud
            // model does, not the local model's short previews.
            modelMode: "cloud",
          }),
        );
        return {
          content: [{ type: "text", text: result.summary }],
          ...(result.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
  return server;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
