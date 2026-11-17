/**
 * MCP Apps (ATO-1135): a server's own UI shown in the chat.
 *
 * MCP Apps is the `io.modelcontextprotocol/ui` extension (SEP-1865,
 * modelcontextprotocol/ext-apps, spec 2026-01-26). A tool names a page
 * in its `tools/list` entry:
 *
 *   `_meta.ui.resourceUri: "ui://..."` (older servers: the flat
 *   `_meta["ui/resourceUri"]`, deprecated by the spec)
 *
 * and the page is an ordinary resource of mimeType
 * `text/html;profile=mcp-app`. After a call the host reads that resource
 * and renders it in a sandboxed frame, next to the call's result.
 *
 * This file is the core half only: read the tool's `_meta.ui`, fetch the
 * page after the call (capped, only the app mimeType), and hand it to a
 * client as `details.mcpApp` on the tool result. The model never sees
 * the page: the prompt carries only a result's summary, and nothing here
 * touches the summary. Rendering, the view's postMessage JSON-RPC and
 * the `ui/*` host methods belong to the client (the desktop's artifact
 * frame, ATO-1136).
 *
 * Everything from the server is untrusted: every field is type-checked
 * and bounded, and anything malformed means "no UI", never a failed call.
 */

import type { McpToolUiMeta } from "./mcp-types.js";

/** The extension id a host advertises in `initialize` (`capabilities.extensions`). */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** The one resource mimeType an MCP App page may have. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Largest page passed on (UTF-8 bytes). Same ceiling as the desktop's
 * artifact frame (`ARTIFACT_MAX_BYTES`, desktop/main/artifact-frame.ts),
 * so anything the core hands over the desktop can show.
 */
export const MCP_APP_MAX_HTML_BYTES = 4 * 1024 * 1024;

/** A URI longer than this is not a page key we keep. */
const MAX_URI_CHARS = 2_048;
/** Per CSP list: at most this many origins, each at most `MAX_ORIGIN_CHARS`. */
const MAX_CSP_ENTRIES = 32;
const MAX_ORIGIN_CHARS = 256;

const CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const;
const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

/** What the page asks of the host's sandbox (`_meta.ui.csp`); every list optional. */
export type McpAppCsp = Partial<Record<(typeof CSP_KEYS)[number], string[]>>;
/** Browser permissions the page asks for (`_meta.ui.permissions`). Requests only. */
export type McpAppPermissions = Partial<Record<(typeof PERMISSION_KEYS)[number], true>>;

/**
 * `details.mcpApp` on an MCP tool result: what a client needs to render
 * the server's page. `csp` and `permissions` are the server's *requests*;
 * the host decides what it grants (the desktop's frame grants none today).
 */
export interface McpAppUi {
  /** The `ui://` resource the page came from. */
  resourceUri: string;
  /** Always `MCP_APP_MIME_TYPE`. */
  mimeType: string;
  /** The page, as the server sent it. */
  html: string;
  csp?: McpAppCsp;
  permissions?: McpAppPermissions;
  /** A dedicated origin the server asks for (`_meta.ui.domain`). */
  domain?: string;
  /** The server's border preference (`_meta.ui.prefersBorder`). */
  prefersBorder?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUiUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > "ui://".length &&
    value.length <= MAX_URI_CHARS &&
    value.toLowerCase().startsWith("ui://") &&
    !/[\s\u0000-\u001f]/.test(value)
  );
}

/**
 * The UI part of a tool's `tools/list` `_meta`, or `undefined` when the
 * tool has none (or a malformed one). `visibility` is kept only when it
 * is a list of the two known audiences.
 */
export function parseToolUiMeta(meta: unknown): McpToolUiMeta | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const uri = ui?.resourceUri ?? meta["ui/resourceUri"];
  let visibility: Array<"model" | "app"> | undefined;
  const rawVisibility: unknown = ui?.visibility;
  if (Array.isArray(rawVisibility)) {
    const known = rawVisibility.filter(
      (v): v is "model" | "app" => v === "model" || v === "app",
    );
    if (known.length === rawVisibility.length) visibility = [...new Set(known)];
  }
  if (!isUiUri(uri)) {
    // An app-only tool without a usable page is still app-only.
    return visibility !== undefined ? { visibility } : undefined;
  }
  return { resourceUri: uri, ...(visibility !== undefined ? { visibility } : {}) };
}

/**
 * Whether the model may be offered this tool. The spec: a host MUST NOT
 * put a tool in the agent's tool list when its `visibility` leaves out
 * `"model"`. Absent visibility means the default, `["model", "app"]`.
 */
export function isModelVisibleTool(ui: McpToolUiMeta | undefined): boolean {
  return ui?.visibility === undefined || ui.visibility.includes("model");
}

/** `text/html;profile=mcp-app`, compared without case or spaces around `;`. */
export function isMcpAppMimeType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.toLowerCase().replace(/\s*;\s*/g, ";").trim() === MCP_APP_MIME_TYPE;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseCsp(value: unknown): McpAppCsp | undefined {
  if (!isRecord(value)) return undefined;
  const out: McpAppCsp = {};
  for (const key of CSP_KEYS) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    const kept = list
      .filter(
        (o): o is string =>
          typeof o === "string" && o.length > 0 && o.length <= MAX_ORIGIN_CHARS && !/[\s;,'"]/.test(o),
      )
      .slice(0, MAX_CSP_ENTRIES);
    if (kept.length > 0) out[key] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePermissions(value: unknown): McpAppPermissions | undefined {
  if (!isRecord(value)) return undefined;
  const out: McpAppPermissions = {};
  for (const key of PERMISSION_KEYS) {
    // The spec writes each as an empty object; accept `true` too.
    if (isRecord(value[key]) || value[key] === true) out[key] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The page out of a `resources/read` result, or `undefined` when the
 * result holds no usable one: the content item for `resourceUri` (or the
 * only item), of the app mimeType, as `text` or base64 `blob`, at most
 * `maxBytes`. `_meta.ui` is read from that content item, where the spec's
 * `resources/read` example puts it.
 */
export function extractMcpAppUi(
  resourceUri: string,
  readResult: unknown,
  maxBytes = MCP_APP_MAX_HTML_BYTES,
): McpAppUi | undefined {
  if (!isRecord(readResult) || !Array.isArray(readResult.contents)) return undefined;
  const contents = readResult.contents.filter(isRecord);
  const item =
    contents.find((c) => c.uri === resourceUri) ??
    (contents.length === 1 ? contents[0] : undefined);
  if (item === undefined || !isMcpAppMimeType(item.mimeType)) return undefined;

  let html: string | undefined;
  if (typeof item.text === "string") {
    if (utf8Bytes(item.text) > maxBytes) return undefined;
    html = item.text;
  } else if (typeof item.blob === "string") {
    // base64 is 4/3 of the bytes: refuse before decoding a huge one.
    if (item.blob.length > Math.ceil((maxBytes * 4) / 3) + 4) return undefined;
    const bytes = Buffer.from(item.blob, "base64");
    if (bytes.length > maxBytes) return undefined;
    html = bytes.toString("utf8");
  }
  if (html === undefined || html.trim().length === 0) return undefined;

  const ui = isRecord(item._meta) && isRecord(item._meta.ui) ? item._meta.ui : {};
  const csp = parseCsp(ui.csp);
  const permissions = parsePermissions(ui.permissions);
  const domain =
    typeof ui.domain === "string" && ui.domain.length > 0 && ui.domain.length <= MAX_ORIGIN_CHARS
      ? ui.domain
      : undefined;
  return {
    resourceUri,
    mimeType: MCP_APP_MIME_TYPE,
    html,
    ...(csp !== undefined ? { csp } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  };
}

/**
 * Read a tool's page after its call. Never throws: a failed read, a
 * wrong mimeType, an oversized page or an aborted turn all mean the
 * result goes out without UI, exactly as for a tool that has none.
 */
export async function fetchMcpAppUi(
  client: { readResource(uri: string, signal: AbortSignal): Promise<Record<string, unknown>> },
  resourceUri: string,
  signal: AbortSignal,
  maxBytes = MCP_APP_MAX_HTML_BYTES,
): Promise<McpAppUi | undefined> {
  if (signal.aborted) return undefined;
  try {
    return extractMcpAppUi(resourceUri, await client.readResource(resourceUri, signal), maxBytes);
  } catch {
    return undefined;
  }
}

/** `capabilities.extensions` entry a host that renders MCP Apps advertises. */
export function mcpAppsClientExtension(): Record<string, { mimeTypes: string[] }> {
  return { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } };
}
