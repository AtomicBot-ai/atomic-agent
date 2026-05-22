/**
 * Resource-class lookup for MCP-namespaced tools.
 *
 * Every qualified MCP tool name looks like `mcp.<server>.<tool>`. The
 * resolver returned by `createMcpResourceClassResolver` keeps a
 * Map<server, ResourceClass> so the agent-loop's `resourceClassFor`
 * call stays O(1).
 *
 * Trust policy (locked invariant — see AGENTS.md §"MCP client"):
 *   - `approval_gated` (default) — every MCP tool invocation is
 *     forbidden inside multi-call batches and routed through the
 *     approval gate. This is the safe default for arbitrary
 *     third-party servers.
 *   - `pure_read` — opt-in for servers the operator trusts never to
 *     mutate anything. These tools fan out parallel-safe alongside
 *     `os.fs.read` / `os.git.*` and bypass approval.
 *
 * The resolver returns `null` for non-MCP names so the caller falls
 * back to the static `TOOL_RESOURCE_CLASS` table — this is what
 * `setDynamicResourceClassResolver` expects.
 */

import type { ResourceClass } from "../agent/tool-resource-class.js";
import type { McpTrustLevel } from "./mcp-types.js";

/** Hardcoded prefix used by `mcp-tool-adapter`. */
export const MCP_TOOL_PREFIX = "mcp.";

/**
 * Construct the qualified agent-visible tool name from a server name
 * and raw tool name. The two arguments are joined by a literal `.`,
 * which is why `server` must not contain dots (enforced by
 * `MCP_SERVER_NAME_RE`).
 */
export function qualifyMcpToolName(server: string, rawName: string): string {
  return `${MCP_TOOL_PREFIX}${server}.${rawName}`;
}

/**
 * Split a qualified MCP tool name into its `{ server, rawName }`
 * parts. Returns `null` when the input is not an MCP-namespaced name.
 * Robust to raw tool names that themselves contain dots (e.g.
 * `os.read_file`) — only the second segment (after the `mcp.` prefix)
 * is consumed as the server name, the rest is the raw tool.
 */
export function splitMcpToolName(
  qualified: string,
): { server: string; rawName: string } | null {
  if (!qualified.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = qualified.slice(MCP_TOOL_PREFIX.length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx <= 0 || dotIdx >= rest.length - 1) return null;
  return {
    server: rest.slice(0, dotIdx),
    rawName: rest.slice(dotIdx + 1),
  };
}

/**
 * Builder for the dynamic resolver consumed by
 * `setDynamicResourceClassResolver`. `serverTrust` is a snapshot of
 * `{ serverName: trustLevel }` derived from `config.mcp.servers`.
 * The resolver maps `pure_read` trust to the `pure_read` resource
 * class and everything else to `approval_gated` (the safe default).
 */
export function createMcpResourceClassResolver(
  serverTrust: ReadonlyMap<string, McpTrustLevel>,
): (toolName: string) => ResourceClass | null {
  return (toolName: string) => {
    const split = splitMcpToolName(toolName);
    if (!split) return null;
    const trust = serverTrust.get(split.server);
    // An MCP tool whose server is not in the trust map either:
    //  (a) belongs to a server that was disabled / failed to connect
    //      — the resolver still returns `approval_gated` so a stale
    //        call would land in the safe lane and be rejected later
    //        at `registry.invoke`.
    //  (b) is a stale name from a model that hallucinated a server.
    //        Same outcome — never `unknown` so the batch validator
    //        does not get extra-clever about it.
    if (trust === "pure_read") return "pure_read";
    return "approval_gated";
  };
}
