/**
 * Project a Composio session onto the neutral `McpServerConfig` the
 * existing MCP manager already knows how to run.
 *
 * This is the whole integration seam: Composio's hosted tool router
 * speaks Streamable HTTP MCP and authenticates with a static header,
 * which is exactly the transport `src/mcp/` already supports. No new
 * tool code, no new transport, no OAuth client — the agent treats
 * Composio as one more MCP server.
 */

import {
  COMPOSIO_API_KEY_HEADER,
  type ComposioSession,
} from "./composio-api.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

/**
 * Reserved server name. Tools land as `mcp.composio.<TOOL>`; the name
 * satisfies `MCP_SERVER_NAME_RE` and is stable so cached approvals and
 * transcripts keep resolving across restarts.
 */
export const COMPOSIO_SERVER_NAME = "composio";

/**
 * Composio's discovery tools: they look up which SaaS action to call and
 * its schema, and never act on an account. Their `readOnlyHint` is
 * trusted although the server is remote (see `trustedReadOnlyTools`).
 */
export const COMPOSIO_DISCOVERY_TOOLS: readonly string[] = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
];

export interface BuildComposioServerConfigOptions {
  session: Pick<ComposioSession, "mcpUrl">;
  apiKey: string;
}

/**
 * Build the synthetic server entry.
 *
 * `trust` stays `approval_gated` — the fail-closed default for any
 * third party. That is not the same as "every call prompts": Composio
 * tags its two discovery tools (`COMPOSIO_SEARCH_TOOLS`,
 * `COMPOSIO_GET_TOOL_SCHEMAS`) `readOnlyHint: true` and its executing
 * tools (`COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`)
 * destructive. Since ATO-1178 a remote server's `readOnlyHint` skips
 * the prompt only for tools named in `trustedReadOnlyTools`, so the two
 * discovery tools are named here by hand: discovery flows silently, any
 * other tool Composio may add or relabel asks, and every write to a
 * real account still hits the approval gate.
 */
export function buildComposioServerConfig(
  opts: BuildComposioServerConfigOptions,
): McpServerConfig {
  return {
    name: COMPOSIO_SERVER_NAME,
    description: "Composio hosted toolkits (1500+ SaaS apps)",
    enabled: true,
    trust: "approval_gated",
    trustedReadOnlyTools: COMPOSIO_DISCOVERY_TOOLS,
    transport: {
      kind: "streamable_http",
      url: opts.session.mcpUrl,
      headers: { [COMPOSIO_API_KEY_HEADER]: opts.apiKey },
    },
  };
}
