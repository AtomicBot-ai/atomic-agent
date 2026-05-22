/**
 * Persistence helper for adding an MCP server config via JSON paste in
 * the TUI's Mcp tab. Pure module-level functions — no orchestrator /
 * runtime / Ink dependencies — so the validation path is trivially
 * unit-testable in isolation.
 *
 * Per variant α (see AGENTS.md §"MCP client" — Out of scope), this
 * helper only mutates `<stateDir>/config.json`. The live `McpManager`
 * is NOT touched; the newly-added server is picked up on the next
 * runtime boot. The orchestrator emits a `runtime_info` line after a
 * successful write reminding the operator to restart.
 */

import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import { parseMcpServers } from "../config/config-schema.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

export class McpAddServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAddServerError";
  }
}

export class McpRemoveServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRemoveServerError";
  }
}

/**
 * Parse + validate a JSON-paste payload as a single `McpServerConfig`.
 *
 * Accepts either:
 *  - A single config object: `{ "name": "...", "transport": {...}, ... }`
 *  - A `{ "mcpServers": { "<name>": {...} } }` envelope (Claude Desktop /
 *    Cursor style). When the envelope holds exactly one entry, the
 *    server name is taken from the key (and `name` in the inner object
 *    is rejected unless it matches the key). Multiple entries are
 *    rejected — the paste UI is single-server on purpose.
 *
 * Throws `McpAddServerError` on any malformed input. Never returns
 * partial / unvalidated data.
 */
export function parseAddServerJson(raw: string): McpServerConfig {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new McpAddServerError("JSON is empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new McpAddServerError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpAddServerError("expected a JSON object");
  }
  const candidate = extractServerObject(parsed as Record<string, unknown>);
  try {
    // `parseMcpServers` runs the canonical validator (name regex,
    // transport shape, trust enum, env shape, etc.) and returns the
    // normalised record.
    const out = parseMcpServers([candidate], "mcp.servers");
    const first = out[0];
    if (!first) {
      throw new McpAddServerError("validation produced empty config");
    }
    return first;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new McpAddServerError(`${err.field}: ${err.message}`);
    }
    throw new McpAddServerError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

interface PersistResult {
  /** Final `mcp.servers[]` length after the write. */
  totalServers: number;
  /** Absolute path to the config file that was written. */
  configPath: string;
  /** Normalised, written server (echo of the validated entry). */
  server: McpServerConfig;
}

/**
 * Append a validated MCP server to `<stateDir>/config.json` and
 * invalidate the global config cache so the next `getConfig()` reflects
 * the change. Rejects duplicates by name.
 *
 * The full file is re-validated through `parseUserConfigFile` before
 * the write so a stale on-disk schema cannot smuggle in invalid state
 * on the back of an unrelated edit.
 */
export function persistMcpServer(server: McpServerConfig): PersistResult {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const prevServers = prev.mcp.servers;
  if (prevServers.some((s) => s.name === server.name)) {
    throw new McpAddServerError(
      `server ${JSON.stringify(server.name)} already exists in config.mcp.servers`,
    );
  }
  const nextMcp = { ...prev.mcp, servers: [...prevServers, server] };
  const draft = { ...prev, mcp: nextMcp };
  try {
    const validated = parseUserConfigFile(draft);
    writeUserConfigFileSync(path, validated);
    resetConfigCache();
    return {
      totalServers: validated.mcp.servers.length,
      configPath: path,
      server,
    };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new McpAddServerError(`${err.field}: ${err.message}`);
    }
    throw new McpAddServerError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

interface RemoveResult {
  /** Final `mcp.servers[]` length after the write. */
  totalServers: number;
  /** Absolute path to the config file that was written. */
  configPath: string;
  /** Name of the server that was removed (echo of the input). */
  removed: string;
}

/**
 * Remove an MCP server from `<stateDir>/config.json` by name and
 * invalidate the global config cache so the next `getConfig()` reflects
 * the change. Throws `McpRemoveServerError` when no server with that
 * name exists (defensive — the TUI only surfaces existing rows, but
 * concurrent edits / stale state are possible).
 *
 * Per variant α: the live `McpManager` is NOT touched. Any session that
 * already loaded the removed server keeps using it until the next
 * runtime restart. The orchestrator emits a `runtime_info` line after a
 * successful write reminding the operator to restart.
 */
export function removeMcpServer(name: string): RemoveResult {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new McpRemoveServerError("server name is empty");
  }
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const prevServers = prev.mcp.servers;
  const idx = prevServers.findIndex((s) => s.name === trimmed);
  if (idx === -1) {
    throw new McpRemoveServerError(
      `server ${JSON.stringify(trimmed)} not found in config.mcp.servers`,
    );
  }
  const nextServers = [...prevServers.slice(0, idx), ...prevServers.slice(idx + 1)];
  const nextMcp = { ...prev.mcp, servers: nextServers };
  const draft = { ...prev, mcp: nextMcp };
  try {
    const validated = parseUserConfigFile(draft);
    writeUserConfigFileSync(path, validated);
    resetConfigCache();
    return {
      totalServers: validated.mcp.servers.length,
      configPath: path,
      removed: trimmed,
    };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new McpRemoveServerError(`${err.field}: ${err.message}`);
    }
    throw new McpRemoveServerError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

function extractServerObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  // Detect the `mcpServers` envelope (Claude Desktop / Cursor format)
  // and unwrap a single entry. Reject 0 or >1 entries — the modal is
  // single-server.
  const envelope = obj.mcpServers;
  if (envelope !== undefined) {
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new McpAddServerError(
        "`mcpServers` must be an object keyed by server name",
      );
    }
    const entries = Object.entries(envelope as Record<string, unknown>);
    if (entries.length === 0) {
      throw new McpAddServerError(
        "`mcpServers` is empty — paste exactly one server",
      );
    }
    if (entries.length > 1) {
      throw new McpAddServerError(
        `paste exactly one server — got ${entries.length} entries in \`mcpServers\``,
      );
    }
    const [keyName, value] = entries[0]!;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new McpAddServerError(
        `\`mcpServers[${JSON.stringify(keyName)}]\` must be an object`,
      );
    }
    const inner = value as Record<string, unknown>;
    if (typeof inner.name === "string" && inner.name !== keyName) {
      throw new McpAddServerError(
        `name mismatch: envelope key ${JSON.stringify(keyName)} vs inner ${JSON.stringify(inner.name)}`,
      );
    }
    return normalizeShortcutShape({ name: keyName, ...inner });
  }
  return normalizeShortcutShape(obj);
}

/**
 * Normalise the Claude Desktop / Cursor "shortcut" shape into the
 * canonical atomic-agent `transport: { kind, ... }` envelope.
 *
 * The shortcut convention used by every common MCP client looks like:
 *
 *   { "command": "npx", "args": ["pkg"], "env": {...} }                  // stdio
 *   { "url": "https://example.com/mcp", "headers": {...} }               // streamable_http
 *   { "serverUrl": "https://example.com/mcp" }                           // Smithery / DeepWiki dialect
 *   { "url": "https://example.com/mcp", "type": "sse" }                  // sse
 *
 * Our own canonical shape is `{ "transport": { "kind": "stdio", ... } }`.
 * To accept paste-as-is JSON from Claude Desktop, Cursor, Smithery,
 * DeepWiki, and the official MCP docs, we promote `command`/`url`/
 * `serverUrl` into the matching transport block when `transport` is
 * absent. When `transport` is already present the input is returned
 * untouched — explicit always wins, even if a stray `command` /
 * `serverUrl` key is also present.
 *
 * `serverUrl` is the catalog-listing dialect used by Smithery, the
 * official DeepWiki examples, and a handful of MCP-server READMEs.
 * It is treated as a strict synonym for `url` — same transport kind
 * resolution rules, same `headers` / `type` follow-on keys.
 */
function normalizeShortcutShape(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (obj.transport !== undefined) return obj;
  if (typeof obj.command === "string") {
    const { command, args, cwd, ...rest } = obj;
    const transport: Record<string, unknown> = { kind: "stdio", command };
    if (args !== undefined) transport.args = args;
    if (cwd !== undefined) transport.cwd = cwd;
    return { ...rest, transport };
  }
  const rawUrl =
    typeof obj.url === "string"
      ? obj.url
      : typeof obj.serverUrl === "string"
        ? obj.serverUrl
        : null;
  if (rawUrl !== null) {
    const { url: _url, serverUrl: _serverUrl, headers, type, ...rest } = obj;
    void _url;
    void _serverUrl;
    // Cursor / mcp.json / Smithery convention: `type` may be "http"
    // | "streamable_http" | "sse". Default to streamable_http (the
    // modern HTTP transport).
    const kind = type === "sse" ? "sse" : "streamable_http";
    const transport: Record<string, unknown> = { kind, url: rawUrl };
    if (headers !== undefined) transport.headers = headers;
    return { ...rest, transport };
  }
  return obj;
}
