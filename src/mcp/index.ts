/**
 * Public surface of the MCP client subsystem.
 *
 * Hosts (CLI / TUI / sidecar / bootstrap) import from this file.
 * The `@modelcontextprotocol/sdk` package is intentionally NOT
 * re-exported — it stays an internal-only dependency of
 * `mcp-client.ts` and `mcp-sampling-handler.ts`.
 */

export { McpClient } from "./mcp-client.js";
export type { McpClientDeps, McpSamplingHandler } from "./mcp-client.js";

export { McpManager } from "./mcp-manager.js";
export type {
  McpManagerDeps,
  McpStatusSink,
} from "./mcp-manager.js";

export { createMcpToolDefinition } from "./mcp-tool-adapter.js";
export type { McpToolGateOptions } from "./mcp-tool-adapter.js";

export {
  buildMcpToolDescriptor,
  buildMcpToolDescriptors,
  mergeMcpDescriptors,
} from "./mcp-descriptor-builder.js";

export {
  applyMcpToolNameRule,
  buildMcpToolNameRule,
} from "./mcp-grammar-builder.js";

export {
  createMcpResourceClassResolver,
  qualifyMcpToolName,
  splitMcpToolName,
  MCP_TOOL_PREFIX,
} from "./mcp-resource-class.js";

export { createMcpSamplingHandler } from "./mcp-sampling-handler.js";

export {
  buildMcpResourceListTool,
  buildMcpResourceReadTool,
} from "./mcp-resource-tools.js";
export {
  buildMcpPromptListTool,
  buildMcpPromptGetTool,
} from "./mcp-prompt-tools.js";

export {
  McpConnectError,
  McpError,
  McpRequestError,
  scrubErrorMessage,
} from "./mcp-errors.js";
export type { McpFailureCategory } from "./mcp-errors.js";

export {
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_NAME_RE,
  MCP_TOOL_NAME_RE,
} from "./mcp-types.js";
export type {
  McpServerConfig,
  McpServerCatalog,
  McpServerState,
  McpServerStatus,
  McpStdioTransport,
  McpStreamableHttpTransport,
  McpSseTransport,
  McpTransport,
  McpToolMeta,
  McpResourceMeta,
  McpPromptMeta,
  McpTrustLevel,
} from "./mcp-types.js";
