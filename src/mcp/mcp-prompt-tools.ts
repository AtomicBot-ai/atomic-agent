/**
 * Agent-facing `mcp.prompt.{list,get}` tools.
 *
 * Single per-runtime registration. The tools dispatch by the
 * `server` arg so the agent does not get one tool per MCP server.
 * Both are read-only (`pure_read` resource class).
 */

import { compressToolResult } from "../compressor/result-compressor.js";
import type { ToolDefinition } from "../tools/tool-registry.js";

import { clampField, flattenKey } from "./mcp-field-text.js";
import type { McpManager } from "./mcp-manager.js";
import { scrubErrorMessage } from "./mcp-errors.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 30;
const MAX_PROMPT_CHARS = 8_000;

/**
 * Per-field width for the one DISPLAY field of a `mcp.prompt.list`
 * row. `name` and the argument names are absent on purpose.
 *
 * Same reasoning as `RESOURCE_FIELD_CHARS` in `mcp-resource-tools`:
 * `mcp-client.ts` copies a prompt's name, description and argument
 * names in verbatim, so an unclamped description lets one template
 * spend the whole listing budget and hide the other 99, and a
 * newline in one breaks the one-prompt-per-line format.
 *
 * But this listing is the catalog the model picks a `mcp.prompt.get`
 * call out of: the prompt `name` is that call's `name` argument and
 * the listed argument names are the keys of its `arguments` object.
 * Shortening either produces a call that cannot succeed — measured
 * before this was split out: a 131-char prompt name listed at 80
 * came back "unknown prompt". So both are made line-safe and left
 * at full length, and only the description is clamped.
 *
 * Row bound is `name + args + 125`: the clamped part is
 * 1 + 1 + 3 + 120 = 125 chars.
 */
const PROMPT_FIELD_CHARS = {
  description: 120,
} as const;

/**
 * The most of a `tool_result.summary` the prompt will ever show:
 * `TOOL_RESULT_RENDER_CAP_CHARS` in `session/conversation-turn.ts`.
 * Only `TOOLS_FULL_BODY_WHEN_FRESH` bypasses it and no `mcp.*` tool
 * is in that set, so anything kept past this point is stored per
 * turn and re-clipped on every render. `MCP_COMPRESSOR_OPTIONS` in
 * `mcp-tool-adapter.ts` is set to the same 8_000 for the same
 * reason.
 */
const RENDER_DELIVERABLE_CHARS = 8_000;

/**
 * Per-call compressor bounds for `mcp.prompt.get`.
 *
 * `projectPromptMessages` already budgets the rendered template at
 * `MAX_PROMPT_CHARS` and stamps its own `…[truncated]` marker.
 * Passing that string to `compressToolResult` with the runtime-wide
 * defaults discarded the budget: `maxTailLines: 12` keeps only the
 * LAST twelve non-blank lines and `maxSummaryLength: 400` then slices
 * the head of the remainder, so an 8 KB rendered prompt reached the
 * model as ~385 chars of its tail — and the `system:`/`user:` opening
 * that carries the instructions was the first thing dropped.
 *
 * The loss is permanent: the conversation turn keeps only `summary`
 * (`session/conversation-turn.ts`), `details` holds just the server,
 * name and the template's description, and re-running the tool
 * renders the same text and cuts it the same way.
 *
 * So we cap at the budget the projector already declared and disable
 * line-based tail truncation. `MAX_PROMPT_CHARS` and
 * `RENDER_DELIVERABLE_CHARS` are both 8_000 — what this tool can
 * produce and what the prompt can deliver happen to coincide here,
 * which is why the number is written as the projector's budget.
 *
 * Caveat inherited from the compressor: `extractTail` drops blank
 * lines unconditionally, so a multi-paragraph template arrives with
 * its paragraph breaks collapsed. The text survives; the blank lines
 * between the messages do not.
 */
const PROMPT_COMPRESSOR_OPTIONS = {
  maxSummaryLength: MAX_PROMPT_CHARS,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * Per-call compressor bounds for `mcp.prompt.list`.
 *
 * Same defect as `mcp.resource.list`, same shape: an ORDERED catalog,
 * one template per line, already bounded by `clampLimit` at
 * `MAX_LIST_LIMIT` rows. The defaults cut it on both axes and both
 * run backwards here — `maxTailLines: 12` keeps the LAST twelve rows
 * of up to a hundred and `maxSummaryLength: 400` slices those to
 * ~385 chars, so a server's first-listed (usually its primary)
 * templates were the ones dropped. This is the catalog the model
 * picks a `mcp.prompt.get` argument from: a name it never saw is a
 * name it cannot call, and `details` reporting `total: 100` next to
 * twelve visible rows gives it no way to reach the rest.
 *
 * Budget: `RENDER_DELIVERABLE_CHARS`, the most the prompt will show.
 * The row builder is what bounds it — see `PROMPT_FIELD_CHARS`,
 * which holds the display part to 125 chars per row on top of the
 * name and argument names. An ordinary row (40-100 chars) leaves
 * all 100 rows `clampLimit` allows well inside 8_000. Tail
 * truncation is off, so an overflowing listing drops its LAST rows
 * and `details.count`/`total` still report the real size.
 */
const LIST_COMPRESSOR_OPTIONS = {
  maxSummaryLength: RENDER_DELIVERABLE_CHARS,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

export function buildMcpPromptListTool(manager: McpManager): ToolDefinition {
  return {
    name: "mcp.prompt.list",
    description:
      "List prompt templates exposed by an MCP server. Args: `server` (string, required), optional `limit` (1..100, default 30). Returns one entry per line: `<name>(arg1, arg2?) — description`.",
    readonly: true,
    async run(rawArgs) {
      const server = coerceServerName(rawArgs.server);
      if (!server) {
        return errorResult("mcp.prompt.list", "server", "server is required");
      }
      const catalog = manager.getCatalog(server);
      if (!catalog) {
        return errorResult(
          "mcp.prompt.list",
          "server",
          `unknown server ${JSON.stringify(server)}`,
        );
      }
      const limit = clampLimit(rawArgs.limit);
      const rows = catalog.prompts.slice(0, limit);
      const lines = rows.map((p) => {
        const argsList = (p.arguments ?? [])
          .map((a) =>
            a.required === false
              ? `${flattenKey(a.name)}?`
              : flattenKey(a.name),
          )
          .join(", ");
        const name = flattenKey(p.name);
        const desc = p.description
          ? ` — ${clampField(p.description, PROMPT_FIELD_CHARS.description)}`
          : "";
        return `${name}(${argsList})${desc}`;
      });
      return compressToolResult(
        {
          tool: "mcp.prompt.list",
          status: "ok",
          output:
            lines.length === 0 ? `(no prompts on ${server})` : lines.join("\n"),
          details: {
            server,
            count: rows.length,
            total: catalog.prompts.length,
          },
        },
        LIST_COMPRESSOR_OPTIONS,
      );
    },
  };
}

export function buildMcpPromptGetTool(manager: McpManager): ToolDefinition {
  return {
    name: "mcp.prompt.get",
    description:
      "Render a prompt template from an MCP server. Args: `server` (string, required), `name` (string, required), optional `arguments` (object of string values for the template parameters). Returns the concatenated rendered message text.",
    readonly: true,
    async run(rawArgs, ctx) {
      const server = coerceServerName(rawArgs.server);
      if (!server) {
        return errorResult("mcp.prompt.get", "server", "server is required");
      }
      const name =
        typeof rawArgs.name === "string" && rawArgs.name.length > 0
          ? rawArgs.name
          : null;
      if (!name) {
        return errorResult("mcp.prompt.get", "name", "name is required");
      }
      const args = normaliseArguments(rawArgs.arguments);
      const client = manager.getClient(server);
      if (!client || !client.isConnected) {
        return errorResult(
          "mcp.prompt.get",
          "server",
          `server ${JSON.stringify(server)} is not connected`,
        );
      }
      try {
        const res = await client.getPrompt(name, args, ctx.signal);
        const projected = projectPromptMessages(res);
        return compressToolResult(
          {
            tool: "mcp.prompt.get",
            status: "ok",
            output: projected || `(empty messages for prompt ${name})`,
            details: {
              server,
              name,
              ...(res &&
              typeof res === "object" &&
              typeof (res as { description?: unknown }).description === "string"
                ? { description: (res as { description: string }).description }
                : {}),
            },
          },
          PROMPT_COMPRESSOR_OPTIONS,
        );
      } catch (err) {
        return errorResult(
          "mcp.prompt.get",
          "transport",
          scrubErrorMessage(err),
        );
      }
    },
  };
}

function projectPromptMessages(res: unknown): string {
  if (!res || typeof res !== "object") return "";
  const messages = (res as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role =
      typeof (m as { role?: unknown }).role === "string"
        ? (m as { role: string }).role
        : "?";
    const content = (m as { content?: unknown }).content;
    let text = "";
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      if (c.type === "text" && typeof c.text === "string") text = c.text;
    } else if (Array.isArray(content)) {
      const buf: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          buf.push((block as { text: string }).text);
        }
      }
      text = buf.join("\n");
    }
    if (text.length > 0) {
      parts.push(`${role}: ${text}`);
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > MAX_PROMPT_CHARS
    ? `${joined.slice(0, MAX_PROMPT_CHARS - 14)}…[truncated]`
    : joined;
}

function normaliseArguments(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return Object.keys(out).length === 0 ? undefined : out;
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
