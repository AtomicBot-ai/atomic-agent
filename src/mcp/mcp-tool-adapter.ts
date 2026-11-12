/**
 * Adapter that wraps an MCP tool descriptor as a `ToolDefinition`
 * usable by the existing `ToolRegistry`. The adapter:
 *
 *   1. Routes the call through `requireApproval` when the owning
 *      server's resolved trust is `approval_gated` — unless the tool
 *      advertised `annotations.readOnlyHint === true` at discovery
 *      time AND that hint is trusted for the tool (`trustReadOnlyHint`:
 *      stdio servers, plus remote tools the agent's own integrations
 *      name). Anything else (missing, malformed, non-boolean, or another
 *      remote HTTP / SSE server) fails closed to gated.
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
import type {
  McpServerConfig,
  McpToolMeta,
  McpTransport,
  McpTrustLevel,
} from "./mcp-types.js";

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
  /**
   * True when this tool's own `readOnlyHint` may skip the prompt. The
   * manager sets it for tools of a stdio server, the transport where the
   * agent launches the server itself, and for the few remote tools the
   * agent's own integrations name (`McpServerConfig.trustedReadOnlyTools`,
   * Composio's discovery tools). Any other remote HTTP / SSE server is
   * someone else's code on someone else's machine: arguments sent there
   * have left this computer, and a prompt injection can talk the model
   * into putting a key into a "search query" (ATO-1178). Absent: fail
   * closed. Note that stdio is not a promise that nothing leaves the
   * machine (a stdio wrapper may call a cloud API); it is the operator's
   * own install, which is the line ATO-1178 draws.
   */
  trustReadOnlyHint?: boolean;
}

/** Whether a transport counts as local for the `readOnlyHint` rule (stdio only). */
export function isLocalMcpTransport(transport: McpTransport): boolean {
  return transport.kind === "stdio";
}

/**
 * Whether `rawName`'s `readOnlyHint` from `config`'s server may skip the
 * prompt: every tool of a stdio server, and on a remote server only the
 * tools the agent itself listed in `trustedReadOnlyTools`. The hint must
 * still be present and exactly `true` (checked by the adapter).
 */
export function trustsReadOnlyHintFor(
  config: Pick<McpServerConfig, "transport" | "trustedReadOnlyTools">,
  rawName: string,
): boolean {
  if (isLocalMcpTransport(config.transport)) return true;
  return config.trustedReadOnlyTools?.includes(rawName) ?? false;
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
  // claim, exactly as the MCP spec defines `readOnlyHint`. And the
  // claim counts only where `trustReadOnlyHint` says so (stdio servers
  // and the agent's own named exceptions): other remote read-only tools
  // ask like everything else (ATO-1178). The prompt still offers "Allow
  // in this chat", so trusting one is one click.
  const dangerous = gate?.dangerous;
  const trustsReadOnlyHint =
    gate?.trustReadOnlyHint === true && meta.annotations?.readOnlyHint === true;
  const gated = gate?.trust === "approval_gated" && !trustsReadOnlyHint;
  return {
    name: meta.qualifiedName,
    description:
      meta.description || `MCP tool ${meta.rawName} on ${meta.server}`,
    // Third-party text: the registry frames it and neutralises fake
    // chat-template tokens before the model reads it.
    untrustedOutput: `MCP server ${meta.server}`,
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
            output: projectMcpResponseToText(res, ctx.modelMode === "cloud"),
            details: extractStructuredDetails(res),
          },
          MCP_COMPRESSOR_OPTIONS,
        );
      } catch (err) {
        // A denial is a local decision, not a server failure — stamp
        // it so downstream consumers (loop detector, traces) never
        // conflate the two, and keep the message unscrubbed: it is
        // generated locally (`describeApprovalDenial`), never server
        // data, and it is what tells the model whether the user said no.
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
                // A repeat of a call the user declined earlier in the
                // turn is their no too, though nobody was asked again.
                deniedByUser: err.byUser || err.declinedEarlier,
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
export function projectMcpResponseToText(res: unknown, full = false): string {
  if (!res || typeof res !== "object") return "";

  const obj = res as Record<string, unknown>;
  // Legacy SDK shape: `{ toolResult: <anything> }`. Render JSON.
  if ("toolResult" in obj && !("content" in obj)) {
    try {
      return clipOutput(JSON.stringify(obj.toolResult, null, 2), full);
    } catch {
      return clipOutput(String(obj.toolResult), full);
    }
  }

  let structured: string | undefined;
  if (obj.structuredContent && typeof obj.structuredContent === "object") {
    try {
      structured = JSON.stringify(obj.structuredContent, null, 2);
      if (!full) return clipOutput(structured);
    } catch {
      // Cyclic / unserialisable structuredContent — fall through to
      // the content-blocks path so the agent still sees something.
    }
  }

  const content = obj.content;
  if (!Array.isArray(content) || content.length === 0) {
    return structured ?? "";
  }
  const parts: string[] = structured ? [structured] : [];
  for (const block of content as Array<Record<string, unknown>>) {
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      if (full && structured && (block.text === structured || block.text === JSON.stringify(obj.structuredContent))) continue;
      parts.push(block.text);
    } else if (type === "image" && typeof block.mimeType === "string") {
      parts.push(`[image ${block.mimeType}]`);
    } else if (type === "audio" && typeof block.mimeType === "string") {
      parts.push(`[audio ${block.mimeType}]`);
    } else if (type === "resource") {
      const r = block.resource;
      if (r && typeof r === "object") {
        const uri = (r as { uri?: unknown }).uri;
        parts.push(`[resource ${typeof uri === "string" ? uri : "(unknown)"}]`);
        if (full && typeof (r as { text?: unknown }).text === "string") parts.push((r as { text: string }).text);
      } else {
        parts.push("[resource]");
      }
    } else if (type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource_link ${block.uri}]`);
    } else {
      parts.push(`[${type || "unknown"}]`);
    }
  }
  return clipOutput(parts.join("\n"), full);
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

function clipOutput(text: string, full = false): string {
  if (full || text.length <= MAX_PROJECTED_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_PROJECTED_OUTPUT_CHARS - 14)}…[truncated]`;
}
