/**
 * MCP (Model Context Protocol) client types.
 *
 * atomic-agent is an MCP **client only** — it connects to external
 * MCP servers and surfaces their `tools` / `resources` / `prompts`
 * through the existing `ToolRegistry`. The agent itself never
 * exposes an MCP server interface.
 *
 * Locked invariant (see AGENTS.md §"MCP client"): the
 * `@modelcontextprotocol/sdk` package is imported from a single
 * file — `src/mcp/mcp-client.ts`. Everything else operates on the
 * neutral shapes defined here.
 */

import type { ResourceClass } from "../agent/tool-resource-class.js";

/**
 * Single MCP server configuration entry. Lives in
 * `<stateDir>/config.json` under `mcp.servers[]` (config v23+).
 *
 * `name` is the operator-chosen namespace prefix. Tools from this
 * server are exposed as `mcp.<name>.<toolName>`; resources / prompts
 * are addressed by `{ server: name, uri | name }` arguments. The
 * `name` is validated against `MCP_SERVER_NAME_RE` so it lands
 * cleanly inside JSON keys, tool names, and GBNF string literals.
 */
export interface McpServerConfig {
  /** Unique operator-chosen namespace (kebab-case, max 32 chars). */
  name: string;
  /** Free-form one-liner for the TUI / logs (optional). */
  description?: string;
  /** Disabled servers are constructed but never connected. */
  enabled: boolean;
  /** Transport descriptor: stdio subprocess or remote HTTP-based. */
  transport: McpTransport;
  /**
   * Per-server resource-class override. `approval_gated` (default)
   * keeps MCP tools out of multi-call batches and gates every
   * invocation behind the approval gate. `pure_read` opts a
   * read-only server into the same fan-out lane as
   * `os.fs.read` / `os.git.*` — use only for servers you trust
   * never to mutate any state.
   */
  trust?: McpTrustLevel;
  /**
   * Optional environment variables overlaid on top of the inherited
   * `process.env` when the transport is `stdio`. The default
   * `process.env` (already loaded from `<stateDir>/.env`) is the
   * baseline; per-server entries win on key collision. Ignored for
   * HTTP / SSE transports.
   */
  env?: Record<string, string>;
}

/**
 * Trust levels translate directly to `ResourceClass` lookups. The
 * default is `approval_gated` — fail-closed and safe for arbitrary
 * third-party servers.
 */
export type McpTrustLevel = "approval_gated" | "pure_read";

export type McpTransport =
  | McpStdioTransport
  | McpStreamableHttpTransport
  | McpSseTransport;

/** Local subprocess wired over stdio. */
export interface McpStdioTransport {
  kind: "stdio";
  /** Absolute or PATH-resolvable executable path. */
  command: string;
  /** CLI arguments. */
  args?: string[];
  /** Optional working directory. Defaults to the agent's cwd. */
  cwd?: string;
}

/** Remote MCP server speaking Streamable HTTP (MCP 2025-03-26+). */
export interface McpStreamableHttpTransport {
  kind: "streamable_http";
  /** Full URL of the `/mcp` endpoint. */
  url: string;
  /** Static headers added to every request. */
  headers?: Record<string, string>;
}

/** Legacy MCP transport speaking HTTP + SSE. */
export interface McpSseTransport {
  kind: "sse";
  /** SSE endpoint URL. */
  url: string;
  /** Static headers added to every request. */
  headers?: Record<string, string>;
}

/** Server lifecycle states observable from outside the manager. */
export type McpServerState =
  | "disabled"
  | "starting"
  | "up"
  | "down";

/** Status snapshot emitted on every observable transition. */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Wall-clock timestamp (ms) of the transition. */
  ts: number;
  /** Short, scrubbed error message — populated when `state === "down"`. */
  lastError?: string;
  /** Number of tools discovered after the most recent successful connect. */
  toolCount?: number;
  /** Number of resources discovered after the most recent successful connect. */
  resourceCount?: number;
  /** Number of prompts discovered after the most recent successful connect. */
  promptCount?: number;
}

/**
 * Neutral descriptor of a tool exposed by an MCP server. Built from
 * the SDK's `Tool` shape but stripped of any SDK-specific objects so
 * downstream consumers (adapter, descriptor builder, grammar builder,
 * TUI) never touch `@modelcontextprotocol/sdk`.
 */
export interface McpToolMeta {
  /** Original tool name as advertised by the server. */
  rawName: string;
  /**
   * Namespaced name actually exposed to the agent — always
   * `mcp.<server>.<rawName>`.
   */
  qualifiedName: string;
  /** Server config name. */
  server: string;
  /** Server-supplied description. Empty when omitted. */
  description: string;
  /**
   * JSON Schema for the `arguments` object the agent must supply when
   * invoking this tool. Forwarded verbatim — the runtime does not
   * validate it locally, the server is the source of truth.
   */
  inputSchema: Record<string, unknown> | null;
  /**
   * Optional annotations forwarded from the server (e.g.
   * `readOnlyHint`, `destructiveHint`, `idempotentHint`). Kept
   * untouched so future trust-derivation policies can read them
   * without re-fetching.
   */
  annotations?: Record<string, unknown>;
  /** Computed resource class — drives batching / approval behaviour. */
  resourceClass: ResourceClass;
}

/** Neutral descriptor of a resource exposed by an MCP server. */
export interface McpResourceMeta {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Neutral descriptor of a prompt exposed by an MCP server. */
export interface McpPromptMeta {
  server: string;
  name: string;
  description?: string;
  /**
   * Argument schema as a list of named parameters (the MCP wire
   * shape). Each entry may carry its own description / required flag
   * — left untouched for downstream consumers.
   */
  arguments?: ReadonlyArray<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Aggregate snapshot of a single server's discovered surface. Returned
 * by `McpClient.refreshCatalog` so callers update tools, resources,
 * and prompts atomically.
 */
export interface McpServerCatalog {
  server: string;
  tools: McpToolMeta[];
  resources: McpResourceMeta[];
  prompts: McpPromptMeta[];
}

/**
 * Validation regex for server names. Mirrors the existing skill-name
 * regex shape (kebab-case + digits, bounded length) so namespacing
 * stays consistent across the codebase. The dots / colons usually
 * found in MCP package names are deliberately forbidden — they would
 * break GBNF tool-name literals and the `mcp.<server>.<tool>`
 * splitter.
 */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
export const MCP_SERVER_NAME_MAX_LENGTH = 32;

/**
 * Validation regex for the **raw** tool name advertised by a server.
 * Tools that fail this check are silently dropped during catalog
 * refresh — the agent never sees them. The regex matches the JSON
 * identifiers MCP servers actually use in the wild plus a few
 * separators (`.`, `_`, `-`). Empty / oversized / control-char names
 * are rejected.
 */
export const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
