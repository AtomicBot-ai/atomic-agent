/**
 * Adapter that wraps an MCP tool descriptor as a `ToolDefinition`
 * usable by the existing `ToolRegistry`. The adapter:
 *
 *   1. Routes the call through `requireApproval` when the owning
 *      server's resolved trust is `approval_gated` — unless the tool
 *      advertised `annotations.readOnlyHint === true` at discovery
 *      time. Anything else (missing, malformed, non-boolean) fails
 *      closed to gated.
 *   2. Forwards `args` verbatim to the MCP server (the server is the
 *      source of truth for input-schema validation).
 *   3. Projects the heterogenous MCP response shape (a list of
 *      content blocks of types `text`, `image`, `resource`, …) into
 *      a single `output` string + structured `details` payload that
 *      `compressToolResult` can summarise the same way native tools
 *      are summarised.
 *   4. Folds any thrown `McpRequestError` (server-side `isError`,
 *      transport failure, timeout) into a `status: "error"`
 *      `CompressedToolResult` so per-call failures never escape as
 *      thrown exceptions — siblings inside a batch keep running. An
 *      `ApprovalDeniedError` is folded the same way but stamped
 *      distinctly (`details.approvalDenied`) so a denial is never
 *      mistaken for a server-side failure.
 */

import {
  ApprovalDeniedError,
  requireApproval,
  type DangerousToolOptions,
} from "../approval/dangerous-tool.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { ToolDefinition } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import { scrubErrorMessage } from "./mcp-errors.js";
import type { McpToolMeta, McpTrustLevel } from "./mcp-types.js";

/** Hard cap on the synthetic `output` string projected from an MCP response. */
const MAX_PROJECTED_OUTPUT_CHARS = 8_000;

/**
 * Per-call compressor bounds for MCP results.
 *
 * The runtime-wide `compressToolResult` default is tuned for log-tail
 * tools (`os.shell.run`, `os.fs.grep`) where a 400-char cap keeps the
 * prompt lean. MCP tools, in contrast, routinely return structured
 * JSON payloads (GitHub issues / PRs, Linear tickets, etc.) on a
 * single line — 400 chars usually clips after the very first record
 * and the model loops on the same call with different filters trying
 * to "find the rest" (observed in session
 * `s-6b8f56ce-10b6-490f-94e0-b7502b384b64`: nine repeated
 * `mcp.github.list_issues` calls against a 9-issue repo).
 *
 * We bump the per-call cap to the same ceiling the projector pre-clips
 * at, so the agent sees the full pre-clipped payload, and we disable
 * line-based tail truncation (which keeps the LAST N lines — exactly
 * the opposite of what we want for an ordered list of records).
 */
const MCP_COMPRESSOR_OPTIONS = {
  maxSummaryLength: MAX_PROJECTED_OUTPUT_CHARS,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

/** Cap on the args-JSON snippet rendered into an approval preview. */
const MAX_APPROVAL_PREVIEW_CHARS = 400;

/**
 * Consent wiring for one server's tools, resolved by `McpManager` at
 * registration time.
 */
export interface McpToolGateOptions {
  /** Resolved trust for the owning server (`config.trust ?? "approval_gated"`). */
  trust: McpTrustLevel;
  /**
   * Shared approval-gate options (same object the native dangerous
   * tools receive). Production wiring always passes it — absence is a
   * test-only seam mirroring `DangerousToolOptions.approvalRequired`
   * being `false`.
   */
  dangerous?: DangerousToolOptions;
}

export function createMcpToolDefinition(
  meta: McpToolMeta,
  client: McpClient,
  gate?: McpToolGateOptions,
): ToolDefinition {
  // Classified once, at registration, from discovery-time data — never
  // from anything the server sends later — so the decision is stable
  // for the tool's lifetime and the descriptor bytes (and with them
  // the KV-cached stable prefix) are untouched. Only a strict boolean
  // `readOnlyHint === true` exempts; missing, malformed, or string
  // annotations fail closed to gated. This is deliberately NARROWER
  // than the `readonly` field below (which also accepts
  // `destructiveHint === false`): `readonly` feeds descriptor
  // rendering, while skipping consent demands the server's strongest
  // claim, exactly as the MCP spec defines `readOnlyHint`.
  const dangerous = gate?.dangerous;
  const gated =
    gate?.trust === "approval_gated" &&
    meta.annotations?.readOnlyHint !== true;
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
        if (gated && dangerous) {
          await requireApproval(
            dangerous,
            {
              sessionId: ctx.sessionId,
              tool: meta.qualifiedName,
              category: "other",
              reason: `call MCP tool ${meta.rawName} on server ${meta.server}`,
              preview: buildApprovalPreview(args),
              affectedResources: [meta.server],
            },
            ctx.signal,
          );
        }
        const res = await client.callTool(meta.rawName, args, ctx.signal);
        return compressToolResult(
          {
            tool: meta.qualifiedName,
            status: "ok",
            output: projectMcpResponseToText(res),
            details: extractStructuredDetails(res),
          },
          MCP_COMPRESSOR_OPTIONS,
        );
      } catch (err) {
        // A denial is an operator decision, not a server failure —
        // stamp it so downstream consumers (loop detector, traces)
        // never conflate the two, and keep the message unscrubbed:
        // it is generated locally, never server data.
        if (err instanceof ApprovalDeniedError) {
          return compressToolResult(
            {
              tool: meta.qualifiedName,
              status: "error",
              output: err.message,
              details: {
                server: meta.server,
                rawName: meta.rawName,
                approvalDenied: true,
              },
            },
            MCP_COMPRESSOR_OPTIONS,
          );
        }
        return compressToolResult(
          {
            tool: meta.qualifiedName,
            status: "error",
            output: scrubErrorMessage(err),
            details: {
              server: meta.server,
              rawName: meta.rawName,
            },
          },
          MCP_COMPRESSOR_OPTIONS,
        );
      }
    },
  };
}

/**
 * Render the outgoing arguments as a clipped JSON snippet for the
 * approval prompt, so the operator sees what would be sent before
 * deciding. Cyclic / unserialisable args degrade to a placeholder —
 * the preview is best-effort, the gate itself never is.
 */
function buildApprovalPreview(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return "(arguments not serialisable)";
  }
  if (json === undefined) return "(no arguments)";
  return json.length > MAX_APPROVAL_PREVIEW_CHARS
    ? `${json.slice(0, MAX_APPROVAL_PREVIEW_CHARS)}…`
    : json;
}

/**
 * Project the MCP `tools/call` response into a single human/agent
 * readable text block.
 *
 * Resolution order:
 *
 *   1. Legacy SDK shape (`{ toolResult }` without `content`) →
 *      pretty-printed JSON of the legacy field.
 *   2. `structuredContent` when present → pretty-printed JSON. Per the
 *      MCP spec `structuredContent` matches the tool's declared
 *      `outputSchema`, so it is the canonical typed payload. The
 *      content text blocks (when also present) are typically a
 *      human-readable mirror of the same data; preferring the typed
 *      form gives the agent line-structured JSON instead of a single
 *      glued-together text blob — which in turn lets the compressor's
 *      8K-char ceiling clip cleanly between records rather than
 *      mid-field.
 *   3. `content[]` text / image / audio / resource markers — the
 *      legacy path, used when no structured payload is provided.
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
      return clipOutput(JSON.stringify(obj.toolResult, null, 2));
    } catch {
      return clipOutput(String(obj.toolResult));
    }
  }

  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    try {
      return clipOutput(JSON.stringify(obj.structuredContent, null, 2));
    } catch {
      // Cyclic / unserialisable structuredContent — fall through to
      // the content-blocks path so the agent still sees something.
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
