import { parseMcpServers } from "../../config/config-schema.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import type { ClaudeCodeMcpServer } from "./claude-code-source.js";

/**
 * Normalise one Claude Code `mcpServers` entry into a validated
 * `McpServerConfig`, or explain why it cannot be.
 *
 * Claude Code's dialect is the common client shortcut — `type` +
 * `command`/`url` at the top level — where atomic-agent's canonical
 * shape is a `transport: { kind, … }` envelope. The mapper builds a
 * clean candidate from the keys it understands and runs it through the
 * canonical validator, so nothing unvalidated can reach the config file.
 */
export type MapMcpResult =
  | { kind: "server"; server: McpServerConfig }
  | { kind: "skip"; reason: string };

export function mapClaudeCodeMcpServer(entry: ClaudeCodeMcpServer): MapMcpResult {
  const raw = entry.raw;
  const type = typeof raw.type === "string" ? raw.type : null;

  let transport: Record<string, unknown>;
  if (typeof raw.command === "string" && (type === null || type === "stdio")) {
    transport = { kind: "stdio", command: raw.command };
    if (Array.isArray(raw.args)) transport.args = raw.args;
  } else if (typeof raw.url === "string") {
    transport = {
      kind: type === "sse" ? "sse" : "streamable_http",
      url: raw.url,
    };
    if (raw.headers && typeof raw.headers === "object") {
      transport.headers = raw.headers;
    }
  } else {
    return {
      kind: "skip",
      reason: `unsupported server shape${type !== null ? ` (type ${JSON.stringify(type)})` : ""} — no command or url`,
    };
  }

  const candidate: Record<string, unknown> = {
    name: entry.name,
    transport,
  };
  if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
    candidate.env = raw.env;
  }

  try {
    const out = parseMcpServers([candidate], "mcp.servers");
    const first = out[0];
    if (!first) return { kind: "skip", reason: "validation produced no config" };
    return { kind: "server", server: first };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return { kind: "skip", reason: `${err.field}: ${err.message}` };
    }
    return {
      kind: "skip",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
