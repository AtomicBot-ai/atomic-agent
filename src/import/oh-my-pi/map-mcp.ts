import { parseMcpServers } from "../../config/config-schema.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import type { MapMcpResult } from "../claude-code/map-mcp.js";
import type { OhMyPiMcpServer } from "./oh-my-pi-source.js";

/**
 * Normalise one Oh-My-Pi `mcpServers` entry into a validated
 * `McpServerConfig`, or explain why it cannot be.
 *
 * Oh-My-Pi's dialect is the common client shortcut — `type` +
 * `command`/`url` at the top level — with `stdio` implied when `type`
 * is absent, `http` meaning a streamable HTTP endpoint, and an
 * optional `cwd` on stdio servers. A server the source marked
 * `disabled` maps to `enabled: false`, so the migrated config says
 * what `mcp.json` said. Oh-My-Pi-only tuning (`timeout`,
 * `requestIdFormat`, `auth`, `oauth`) has no counterpart here and is
 * dropped. The candidate runs through the canonical validator, so
 * nothing unvalidated can reach the config file.
 */
export function mapOhMyPiMcpServer(entry: OhMyPiMcpServer): MapMcpResult {
  const raw = entry.raw;
  const type = typeof raw.type === "string" ? raw.type : null;

  let transport: Record<string, unknown>;
  if (typeof raw.command === "string" && (type === null || type === "stdio")) {
    transport = { kind: "stdio", command: raw.command };
    if (Array.isArray(raw.args)) transport.args = raw.args;
    if (typeof raw.cwd === "string") transport.cwd = raw.cwd;
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
  if (entry.disabled) candidate.enabled = false;

  try {
    const out = parseMcpServers([candidate], "mcp.servers");
    const first = out[0];
    if (!first)
      return { kind: "skip", reason: "validation produced no config" };
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
