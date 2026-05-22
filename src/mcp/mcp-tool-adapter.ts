/**
 * Adapter that wraps an MCP tool descriptor as a `ToolDefinition`
 * usable by the existing `ToolRegistry`. The adapter:
 *
 *   1. Forwards `args` verbatim to the MCP server (the server is the
 *      source of truth for input-schema validation).
 *   2. Projects the heterogenous MCP response shape (a list of
 *      content blocks of types `text`, `image`, `resource`, …) into
 *      a single `output` string + structured `details` payload that
 *      `compressToolResult` can summarise the same way native tools
 *      are summarised.
 *   3. Folds any thrown `McpRequestError` (server-side `isError`,
 *      transport failure, timeout) into a `status: "error"`
 *      `CompressedToolResult` so per-call failures never escape as
 *      thrown exceptions — siblings inside a batch keep running.
 */

import { compressToolResult } from "../compressor/result-compressor.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { ToolDefinition } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import { scrubErrorMessage } from "./mcp-errors.js";
import type { McpToolMeta } from "./mcp-types.js";

/** Hard cap on the synthetic `output` string projected from an MCP response. */
const MAX_PROJECTED_OUTPUT_CHARS = 8_000;

export function createMcpToolDefinition(
  meta: McpToolMeta,
  client: McpClient,
): ToolDefinition {
  return {
    name: meta.qualifiedName,
    description: meta.description || `MCP tool ${meta.rawName} on ${meta.server}`,
    // MCP tools are arbitrary third-party code — even when the server
    // advertises `readOnlyHint`, we cannot trust the wire flag for
    // batch-safety. The runtime's batching decision is owned by the
    // operator-configured trust level in `mcp.servers[]`, not the
    // descriptor's `readonly` field — but we still surface the hint
    // so the descriptor builder can render it in `### tools`.
    readonly:
      meta.annotations?.readOnlyHint === true ||
      meta.annotations?.destructiveHint === false,
    run: async (args, ctx): Promise<CompressedToolResult> => {
      try {
        const res = await client.callTool(meta.rawName, args, ctx.signal);
        return compressToolResult({
          tool: meta.qualifiedName,
          status: "ok",
          output: projectMcpResponseToText(res),
          details: extractStructuredDetails(res),
        });
      } catch (err) {
        return compressToolResult({
          tool: meta.qualifiedName,
          status: "error",
          output: scrubErrorMessage(err),
          details: {
            server: meta.server,
            rawName: meta.rawName,
          },
        });
      }
    },
  };
}

/**
 * Project the MCP `tools/call` response into a single human/agent
 * readable text block. Concatenates text content; for image / audio
 * / resource blocks, emits a one-line marker that names the type
 * (the binary payload itself is not surfaced — the agent has the
 * MCP resource reader for that).
 *
 * Capped to `MAX_PROJECTED_OUTPUT_CHARS` with a `[truncated]`
 * suffix so a verbose MCP server cannot blow the compressor's
 * single-call ceiling.
 */
export function projectMcpResponseToText(res: unknown): string {
  if (!res || typeof res !== "object") return "";

  const obj = res as Record<string, unknown>;
  // Legacy SDK shape: `{ toolResult: <anything> }`. Render JSON.
  if ("toolResult" in obj && !("content" in obj)) {
    try {
      return clipOutput(JSON.stringify(obj.toolResult));
    } catch {
      return clipOutput(String(obj.toolResult));
    }
  }

  const content = obj.content;
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "image" && typeof block.mimeType === "string") {
      parts.push(`[image ${block.mimeType}]`);
    } else if (type === "audio" && typeof block.mimeType === "string") {
      parts.push(`[audio ${block.mimeType}]`);
    } else if (type === "resource") {
      const r = block.resource;
      if (r && typeof r === "object") {
        const uri = (r as { uri?: unknown }).uri;
        parts.push(
          `[resource ${typeof uri === "string" ? uri : "(unknown)"}]`,
        );
      } else {
        parts.push("[resource]");
      }
    } else if (type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource_link ${block.uri}]`);
    } else {
      parts.push(`[${type || "unknown"}]`);
    }
  }
  return clipOutput(parts.join("\n"));
}

/**
 * Pull structured fields out of the MCP response into the
 * `CompressedToolResult.details` payload. `structuredContent` is
 * forwarded verbatim because MCP guarantees it matches the tool's
 * declared `outputSchema`.
 */
export function extractStructuredDetails(
  res: unknown,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  if (!res || typeof res !== "object") return details;
  const obj = res as Record<string, unknown>;
  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    details.structuredContent = obj.structuredContent;
  }
  if (obj._meta && typeof obj._meta === "object") {
    details.meta = obj._meta;
  }
  return details;
}

function clipOutput(text: string): string {
  if (text.length <= MAX_PROJECTED_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_PROJECTED_OUTPUT_CHARS - 14)}…[truncated]`;
}
