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

/**
 * The most of a `tool_result.summary` the prompt will ever show:
 * `TOOL_RESULT_RENDER_CAP_CHARS` in `session/conversation-turn.ts`
 * (see the constant there, and `renderToolResultBody` below it).
 * Only the tools in `TOOLS_FULL_BODY_WHEN_FRESH` bypass it, and no
 * `mcp.*` tool is in that set, so anything a compressor budget keeps
 * past this point is stored per turn and re-clipped on every render.
 * `MCP_COMPRESSOR_OPTIONS` in `mcp-tool-adapter.ts` is set to the
 * same 8_000 for the same reason.
 */
const RENDER_DELIVERABLE_CHARS = 8_000;

/**
 * Per-call compressor bounds for `mcp.resource.read`.
 *
 * `projectResourceContents` already budgets the payload at
 * `MAX_READ_CHARS` and stamps its own `…[truncated]` marker when it
 * clips. Handing that string to `compressToolResult` with the
 * runtime-wide defaults threw the budget away twice over:
 * `maxTailLines: 12` keeps only the LAST twelve non-blank lines, and
 * `maxSummaryLength: 400` then slices the head of whatever survived —
 * so a 16 KB document reached the model as ~385 chars taken from
 * somewhere in its middle, with its opening silently gone.
 *
 * The loss is not a rendering detail: the conversation turn stores
 * only `summary` (`session/conversation-turn.ts`), `details` here is
 * just `{ server, uri }`, and the tool exposes no offset/paging arg,
 * so re-reading the resource reproduces the very same slice.
 *
 * A resource is a document, not a log tail: the head is the part that
 * matters, so line-based tail truncation is disabled.
 *
 * Budget — two different numbers, deliberately: the projector can
 * PRODUCE `MAX_READ_CHARS` (16_000), but the prompt can DELIVER only
 * `RENDER_DELIVERABLE_CHARS` (8_000), so we cap here rather than
 * store 16 KB per turn that the renderer cuts in half again every
 * time. Measured on the 8_000/16_000 pair: a 15_998-char summary
 * renders as 7_995 chars either way. If these tools are ever added
 * to `TOOLS_FULL_BODY_WHEN_FRESH` so a fresh read arrives whole,
 * this constant becomes the binding limit and should go back up to
 * `MAX_READ_CHARS`.
 *
 * Caveat inherited from the compressor: `extractTail` drops blank
 * lines unconditionally, so a markdown resource arrives with its
 * paragraph breaks collapsed. Every character of text survives; the
 * blank lines between them do not.
 */
const READ_COMPRESSOR_OPTIONS = {
  maxSummaryLength: RENDER_DELIVERABLE_CHARS,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * Per-call compressor bounds for `mcp.resource.list`.
 *
 * The listing is an ORDERED catalog, one resource per line, already
 * bounded by `clampLimit` at `MAX_LIST_LIMIT` rows. On the defaults
 * it was cut on both axes at once, and both cuts run backwards for a
 * listing: `maxTailLines: 12` keeps the LAST twelve rows of up to a
 * hundred, and `maxSummaryLength: 400` then slices those to ~385
 * chars. A 100-resource server therefore advertised its final dozen
 * entries and nothing else — and since the rows are emitted in
 * catalog order, the resources a server lists first (its index, its
 * README, its entry points) were exactly the ones discarded. The
 * tool takes no offset argument, so re-listing returns the same
 * twelve; `details` carries `count`/`total`, so the model could see
 * that 100 existed while being shown 12, with no way to ask for the
 * rest.
 *
 * Budget: `RENDER_DELIVERABLE_CHARS`, the most the prompt will show
 * (see that constant). A listing has no projector budget of its own
 * to inherit, and no useful ceiling can be computed from the rows:
 * nothing clamps a resource's uri, name, description or mimeType —
 * `mcp-client.ts` copies all four verbatim from the server and the
 * row builder interpolates them raw — so a single verbose server can
 * make one row arbitrarily wide. A typical row (`<uri> [mime] name —
 * description`) runs 70-120 chars, so the 100 rows `clampLimit`
 * allows usually fit inside 8_000 with room to spare; when they do
 * not, tail truncation is off, so the cut stays head-anchored and it
 * is the last rows that go, not the first.
 */
const LIST_COMPRESSOR_OPTIONS = {
  maxSummaryLength: RENDER_DELIVERABLE_CHARS,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

export function buildMcpResourceListTool(manager: McpManager): ToolDefinition {
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
      return compressToolResult(
        {
          tool: "mcp.resource.list",
          status: "ok",
          output:
            lines.length === 0
              ? `(no resources on ${server})`
              : lines.join("\n"),
          details: {
            server,
            count: rows.length,
            total: catalog.resources.length,
          },
        },
        LIST_COMPRESSOR_OPTIONS,
      );
    },
  };
}

export function buildMcpResourceReadTool(manager: McpManager): ToolDefinition {
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
        return compressToolResult(
          {
            tool: "mcp.resource.read",
            status: "ok",
            output: projected || `(empty contents for ${uri})`,
            details: { server, uri },
          },
          READ_COMPRESSOR_OPTIONS,
        );
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
