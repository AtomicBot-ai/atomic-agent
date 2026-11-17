/**
 * MCP Apps (ATO-552, epic ATO-1010): a tool may name an HTML page its
 * server ships as a `ui://` resource, and a host shows that page next to
 * the tool's result. Spec: the MCP Apps extension, SEP-1865
 * (`io.modelcontextprotocol/ui`,
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx):
 * the tool descriptor carries `_meta.ui.resourceUri` (older servers:
 * the flat `_meta["ui/resourceUri"]`), and `resources/read` on it returns
 * `text/html;profile=mcp-app` content (older drafts: `text/html+mcp`).
 *
 * This module does the three host-side steps:
 *
 *   1. `mcpAppResourceUriOf` picks the URI out of a tool's `_meta` at
 *      discovery time (only `ui://`, so a tool cannot point the host at
 *      a file or web address).
 *   2. `readMcpAppResource` reads it from the SAME server after an ok
 *      call, with its own short deadline and a size cap, and returns
 *      undefined on any failure: the page is a bonus, the tool call has
 *      already succeeded and must stay that way.
 *   3. `attachMcpApp` / `mcpAppRecordOf` put the page on the result's
 *      `details` for the stream to hand to the chat, and read it back.
 *
 * The model never sees the page. `details` are not rendered into the
 * prompt, and the record is attached as a NON-enumerable property, the
 * same trick `CompressedToolResult.fullOutput` uses: the session file
 * (`latestResult.details`), traces, secret masking and the loop
 * detector's result hash all walk or serialise enumerable keys only, so
 * up to a megabyte of HTML is not written to disk on every call or
 * hashed every step. The stream reads it by name and ships it once.
 */

import type { CompressedToolResult } from "../compressor/result-compressor.js";

import type { McpClient } from "./mcp-client.js";

/** Key of the app record in the result's `details`. */
export const MCP_APP_DETAIL = "mcpApp";

/** Largest page we carry to the chat (UTF-8 bytes). */
export const MCP_APP_MAX_BYTES = 1024 * 1024;

/** How long the page read may take after the call itself finished. */
export const MCP_APP_READ_TIMEOUT_MS = 10_000;

/** Longest `ui://` URI we accept from a descriptor. */
const MAX_URI_LENGTH = 2048;

/**
 * HTML mime types a server may label the page with: the current spec's
 * profile, the earlier draft's `+mcp`, and the OpenAI Apps SDK's
 * `+skybridge`, which the same servers often ship. Compared on the base
 * type (before any `;`), lowercased.
 */
const APP_MIME_BASES: ReadonlySet<string> = new Set([
  "text/html",
  "text/html+mcp",
  "text/html+skybridge",
]);

/** What a host needs to show an MCP app: whose page, which one, and the page. */
export interface McpAppRecord {
  server: string;
  uri: string;
  title: string;
  html: string;
  bytes: number;
}

function isUiUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > "ui://".length &&
    value.length <= MAX_URI_LENGTH &&
    value.toLowerCase().startsWith("ui://") &&
    !/[\s\u0000-\u001f]/.test(value)
  );
}

/**
 * The `ui://` page a tool descriptor's `_meta` names, or undefined.
 * Reads `_meta.ui.resourceUri` first, then the deprecated flat
 * `_meta["ui/resourceUri"]`. Anything that is not a `ui://` URI is
 * ignored, never followed.
 */
export function mcpAppResourceUriOf(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const ui = record.ui;
  if (ui !== null && typeof ui === "object") {
    const nested = (ui as Record<string, unknown>).resourceUri;
    if (isUiUri(nested)) return nested;
  }
  const flat = record["ui/resourceUri"];
  return isUiUri(flat) ? flat : undefined;
}

function isAppMime(mime: unknown): boolean {
  if (typeof mime !== "string") return false;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return APP_MIME_BASES.has(base);
}

/**
 * The HTML of one `resources/read` content entry, or undefined when it
 * is not an app page or is too big. Accepts `text` and base64 `blob`;
 * a blob is size-checked before it is decoded.
 */
function htmlOfContent(entry: Record<string, unknown>, maxBytes: number): string | undefined {
  if (!isAppMime(entry.mimeType)) return undefined;
  if (typeof entry.text === "string") {
    return Buffer.byteLength(entry.text, "utf8") <= maxBytes ? entry.text : undefined;
  }
  if (typeof entry.blob === "string") {
    // base64 is 4 chars per 3 bytes: anything longer cannot fit.
    if (entry.blob.length > Math.ceil(maxBytes / 3) * 4 + 4) return undefined;
    const decoded = Buffer.from(entry.blob, "base64");
    return decoded.byteLength <= maxBytes ? decoded.toString("utf8") : undefined;
  }
  return undefined;
}

export interface ReadMcpAppOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Read the app page `uri` from `client` (the server that owns the tool
 * just called) and return it as a record, or undefined on ANY failure:
 * not `ui://`, read error or timeout, no HTML content, an empty page,
 * or one over the size cap. Never throws.
 */
export async function readMcpAppResource(
  client: Pick<McpClient, "readResource">,
  server: string,
  uri: string,
  title: string,
  signal: AbortSignal,
  options: ReadMcpAppOptions = {},
): Promise<McpAppRecord | undefined> {
  if (!isUiUri(uri) || signal.aborted) return undefined;
  const maxBytes = options.maxBytes ?? MCP_APP_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? MCP_APP_READ_TIMEOUT_MS;
  try {
    const res = await client.readResource(
      uri,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
    const contents = (res as { contents?: unknown }).contents;
    if (!Array.isArray(contents)) return undefined;
    const entries = contents.filter(
      (c): c is Record<string, unknown> => c !== null && typeof c === "object",
    );
    // The entry for this URI; a server that echoes no URI on its single
    // entry still counts.
    const entry =
      entries.find((c) => c.uri === uri) ??
      (entries.length === 1 && entries[0]!.uri === undefined ? entries[0] : undefined);
    if (entry === undefined) return undefined;
    const html = htmlOfContent(entry, maxBytes);
    if (html === undefined || html.trim().length === 0) return undefined;
    return { server, uri, title, html, bytes: Buffer.byteLength(html, "utf8") };
  } catch {
    return undefined;
  }
}

/**
 * Put `record` on `details` under `mcpApp`, non-enumerable so nothing
 * that copies, masks, hashes or saves `details` carries the page along
 * (see the module comment). Returns `details` for chaining.
 */
export function attachMcpApp(
  details: Record<string, unknown>,
  record: McpAppRecord,
): Record<string, unknown> {
  Object.defineProperty(details, MCP_APP_DETAIL, {
    value: record,
    enumerable: false,
    configurable: true,
  });
  return details;
}

/**
 * The app page an ok MCP tool call brought back, for the stream's
 * `tool_result` frame. Undefined for any other call, a failed one, or a
 * shape a host could not show.
 */
export function mcpAppRecordOf(result: CompressedToolResult): McpAppRecord | undefined {
  if (result.status !== "ok" || !result.tool.startsWith("mcp.")) return undefined;
  const raw = (result.details ?? {})[MCP_APP_DETAIL];
  if (raw === null || typeof raw !== "object") return undefined;
  const { server, uri, title, html, bytes } = raw as Record<string, unknown>;
  if (typeof server !== "string" || server.length === 0) return undefined;
  if (!isUiUri(uri) || typeof title !== "string") return undefined;
  if (typeof html !== "string" || html.length === 0) return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes > MCP_APP_MAX_BYTES) return undefined;
  return { server, uri, title, html, bytes };
}

/**
 * Copy the app record from one `details` to a rebuilt one: a wrapper
 * that spreads `details` into a new object (a PostToolUse hook's notes)
 * would otherwise drop the non-enumerable page. Returns `to`.
 */
export function carryMcpApp(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown>,
): Record<string, unknown> {
  const record = from?.[MCP_APP_DETAIL];
  if (record !== null && typeof record === "object" && !(MCP_APP_DETAIL in to)) {
    attachMcpApp(to, record as McpAppRecord);
  }
  return to;
}
