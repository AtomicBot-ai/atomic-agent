/**
 * Agent-facing `mcp.resource.{list,read}` tools.
 *
 * Single per-runtime registration. The tools dispatch by the
 * `server` arg so the agent does not get one tool per MCP server
 * (the prompt would explode). The tools are always-readonly
 * (`pure_read` resource class — see `tool-resource-class.ts` for
 * the wider `mcp.*` policy).
 */

import { compressToolResult } from "../compressor/result-compressor.js";
import type { ToolDefinition } from "../tools/tool-registry.js";

import type { McpManager } from "./mcp-manager.js";
import { scrubErrorMessage } from "./mcp-errors.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 30;
const MAX_READ_CHARS = 16_000;

export function buildMcpResourceListTool(
  manager: McpManager,
): ToolDefinition {
  return {
    name: "mcp.resource.list",
    description:
      "List resources exposed by an MCP server. Args: `server` (string, required — one of the configured MCP server names), optional `limit` (1..100, default 30). Returns one entry per line: `<uri> [mime] name — description`.",
    readonly: true,
    async run(rawArgs) {
      const server = coerceServerName(rawArgs.server);
      if (!server) {
        return errorResult("mcp.resource.list", "server", "server is required");
      }
      const catalog = manager.getCatalog(server);
      if (!catalog) {
        return errorResult(
          "mcp.resource.list",
          "server",
          `unknown server ${JSON.stringify(server)}`,
        );
      }
      const limit = clampLimit(rawArgs.limit);
      const rows = catalog.resources.slice(0, limit);
      const lines = rows.map((r) => {
        const mime = r.mimeType ? `[${r.mimeType}]` : "";
        const name = r.name ? ` ${r.name}` : "";
        const desc = r.description ? ` — ${r.description}` : "";
        return `${r.uri} ${mime}${name}${desc}`.trim();
      });
      return compressToolResult({
        tool: "mcp.resource.list",
        status: "ok",
        output: lines.length === 0 ? `(no resources on ${server})` : lines.join("\n"),
        details: {
          server,
          count: rows.length,
          total: catalog.resources.length,
        },
      });
    },
  };
}

export function buildMcpResourceReadTool(
  manager: McpManager,
): ToolDefinition {
  return {
    name: "mcp.resource.read",
    description:
      "Read a resource exposed by an MCP server. Args: `server` (string, required), `uri` (string, required — exact URI as returned by `mcp.resource.list`). Returns the concatenated text contents (binary blobs are skipped).",
    readonly: true,
    async run(rawArgs, ctx) {
      const server = coerceServerName(rawArgs.server);
      if (!server) {
        return errorResult("mcp.resource.read", "server", "server is required");
      }
      const uri =
        typeof rawArgs.uri === "string" && rawArgs.uri.length > 0
          ? rawArgs.uri
          : null;
      if (!uri) {
        return errorResult("mcp.resource.read", "uri", "uri is required");
      }
      const client = manager.getClient(server);
      if (!client || !client.isConnected) {
        return errorResult(
          "mcp.resource.read",
          "server",
          `server ${JSON.stringify(server)} is not connected`,
        );
      }
      try {
        const res = await client.readResource(uri, ctx.signal);
        const projected = projectResourceContents(res);
        return compressToolResult({
          tool: "mcp.resource.read",
          status: "ok",
          output: projected || `(empty contents for ${uri})`,
          details: { server, uri },
        });
      } catch (err) {
        return errorResult(
          "mcp.resource.read",
          "transport",
          scrubErrorMessage(err),
        );
      }
    },
  };
}

function projectResourceContents(res: unknown): string {
  if (!res || typeof res !== "object") return "";
  const contents = (res as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return "";
  const parts: string[] = [];
  for (const block of contents) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.blob === "string") {
      const mime = typeof b.mimeType === "string" ? b.mimeType : "binary";
      parts.push(`[blob ${mime} ${b.blob.length} chars base64 omitted]`);
    }
  }
  const joined = parts.join("\n");
  return joined.length > MAX_READ_CHARS
    ? `${joined.slice(0, MAX_READ_CHARS - 14)}…[truncated]`
    : joined;
}

function coerceServerName(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

function clampLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return Math.min(raw, MAX_LIST_LIMIT);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return Math.min(Number.parseInt(raw, 10), MAX_LIST_LIMIT);
  }
  return DEFAULT_LIST_LIMIT;
}

function errorResult(tool: string, field: string, reason: string) {
  return compressToolResult({
    tool,
    status: "error",
    output: `validation: ${field}: ${reason}`,
    details: { field, reason },
  });
}
