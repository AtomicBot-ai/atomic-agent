import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parseNonEmptyString } from "./config-primitives.js";
import { parseStringArrayOrNull, parseUrl } from "./config-values.js";
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_NAME_RE,
  type McpServerConfig,
  type McpTransport,
  type McpTrustLevel,
} from "../mcp/mcp-types.js";

function parseMcpTrustLevel(raw: unknown, field: string): McpTrustLevel {
  if (raw === "approval_gated" || raw === "pure_read") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of approval_gated|pure_read, got ${JSON.stringify(raw)}`,
  );
}

function parseMcpEnv(
  raw: unknown,
  field: string,
): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "env var name must match [A-Za-z_][A-Za-z0-9_]*",
      );
    }
    if (typeof v !== "string") {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "env value must be a string",
      );
    }
    out[k] = v;
  }
  return out;
}

// HTTP header field names are RFC 7230 tokens, not env-var names — they
// routinely contain hyphens (`X-CMC-MCP-API-KEY`). Validate against the token
// grammar instead of the `[A-Za-z_][A-Za-z0-9_]*` pattern used for stdio `env`.
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function parseMcpHeaders(
  raw: unknown,
  field: string,
): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HTTP_HEADER_NAME_RE.test(k)) {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "http header name must be a valid RFC 7230 token",
      );
    }
    if (typeof v !== "string") {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "http header value must be a string",
      );
    }
    out[k] = v;
  }
  return out;
}

function parseMcpTransport(raw: unknown, field: string): McpTransport {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected transport object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "stdio") {
    const command = parseNonEmptyString(obj.command, `${field}.command`);
    const args =
      obj.args === undefined
        ? undefined
        : parseStringArrayOrNull(obj.args, `${field}.args`);
    const cwd =
      obj.cwd === undefined || obj.cwd === null
        ? undefined
        : parseNonEmptyString(obj.cwd, `${field}.cwd`);
    return {
      kind: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (obj.kind === "streamable_http") {
    const url = parseUrl(obj.url, `${field}.url`);
    const headers =
      obj.headers === undefined || obj.headers === null
        ? undefined
        : parseMcpHeaders(obj.headers, `${field}.headers`);
    return {
      kind: "streamable_http",
      url,
      ...(headers ? { headers } : {}),
    };
  }
  if (obj.kind === "sse") {
    const url = parseUrl(obj.url, `${field}.url`);
    const headers =
      obj.headers === undefined || obj.headers === null
        ? undefined
        : parseMcpHeaders(obj.headers, `${field}.headers`);
    return {
      kind: "sse",
      url,
      ...(headers ? { headers } : {}),
    };
  }
  throw new ConfigValidationError(
    `${field}.kind`,
    `expected stdio|streamable_http|sse, got ${JSON.stringify(obj.kind)}`,
  );
}

/**
 * Validate and normalise the `mcp.servers[]` list. Each entry is
 * checked for a valid namespace name, an enabled flag, and a
 * well-formed transport. Duplicate names are rejected — the
 * namespace becomes the `mcp.<name>.<tool>` prefix and must be
 * unique. Empty input is accepted.
 */
export function parseMcpServers(
  raw: unknown,
  field: string,
): McpServerConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected array, got ${JSON.stringify(raw)}`,
    );
  }
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected object, got ${JSON.stringify(entry)}`,
      );
    }
    const cfg = entry as Record<string, unknown>;
    const name = parseNonEmptyString(cfg.name, `${field}[${i}].name`);
    if (name.length > MCP_SERVER_NAME_MAX_LENGTH) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `name exceeds ${MCP_SERVER_NAME_MAX_LENGTH} chars`,
      );
    }
    if (!MCP_SERVER_NAME_RE.test(name)) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `name must match ${MCP_SERVER_NAME_RE.source}`,
      );
    }
    if (seen.has(name)) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `duplicate server name ${JSON.stringify(name)}`,
      );
    }
    seen.add(name);
    const enabled = parseBool(
      cfg.enabled === undefined ? true : cfg.enabled,
      `${field}[${i}].enabled`,
    );
    const description =
      cfg.description === undefined || cfg.description === null
        ? undefined
        : parseNonEmptyString(cfg.description, `${field}[${i}].description`);
    const transport = parseMcpTransport(
      cfg.transport,
      `${field}[${i}].transport`,
    );
    const trust =
      cfg.trust === undefined || cfg.trust === null
        ? undefined
        : parseMcpTrustLevel(cfg.trust, `${field}[${i}].trust`);
    const env =
      cfg.env === undefined || cfg.env === null
        ? undefined
        : parseMcpEnv(cfg.env, `${field}[${i}].env`);
    out.push({
      name,
      enabled,
      transport,
      ...(description ? { description } : {}),
      ...(trust ? { trust } : {}),
      ...(env ? { env } : {}),
    });
  }
  return out;
}
