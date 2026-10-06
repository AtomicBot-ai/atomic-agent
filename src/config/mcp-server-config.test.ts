import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  parseMcpServers as parseComposedMcpServers,
  parseStringArrayOrNull as parseComposedStringArray,
  parseUrl as parseComposedUrl,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { parseStringArrayOrNull, parseUrl } from "./config-values.js";
import { ConfigValidationError as OwnedValidationError } from "./config-validation-error.js";
import { parseMcpServers } from "./mcp-server-config.js";
import { McpAddServerError, parseAddServerJson } from "./mcp-server-commands.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

const STDIO = { kind: "stdio", command: "synthetic-command" };

function parsedServer(raw: unknown): McpServerConfig {
  const server = parseMcpServers([raw], "mcp.servers")[0];
  if (server === undefined) throw new Error("parsed MCP fixture is missing");
  return server;
}

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected MCP fixture validation to reject");
}

describe("MCP server configuration and shared values", () => {
  it("keeps root functions and the original validation-error class", () => {
    expect(parseComposedMcpServers).toBe(parseMcpServers);
    expect(parseComposedStringArray).toBe(parseStringArrayOrNull);
    expect(parseComposedUrl).toBe(parseUrl);
    expect(ConfigValidationError).toBe(OwnedValidationError);
  });

  it("composes mixed transports without materializing null optionals or dropping empty maps", () => {
    const servers = [
      {
        name: "stdio-fixture",
        enabled: false,
        description: null,
        trust: null,
        env: null,
        transport: { kind: "stdio", command: " ", args: null, cwd: null },
      },
      {
        name: "http-fixture",
        description: " synthetic description ",
        trust: "pure_read",
        env: {},
        transport: {
          kind: "streamable_http",
          url: "https://example.invalid/mcp",
          headers: {},
        },
      },
      {
        name: "sse-fixture",
        env: { SYNTHETIC_EMPTY: "" },
        transport: { kind: "sse", url: "https://example.invalid/sse", headers: null },
      },
    ];
    const expected = [
      { name: "stdio-fixture", enabled: false, transport: { kind: "stdio", command: " " } },
      {
        name: "http-fixture",
        enabled: true,
        transport: { kind: "streamable_http", url: "https://example.invalid/mcp", headers: {} },
        description: " synthetic description ",
        trust: "pure_read",
        env: {},
      },
      {
        name: "sse-fixture",
        enabled: true,
        transport: { kind: "sse", url: "https://example.invalid/sse" },
        env: { SYNTHETIC_EMPTY: "" },
      },
    ];
    expect(parseMcpServers(servers, "mcp.servers")).toStrictEqual(expected);
    const config = parseUserConfigFile({ ...USER_CONFIG_DEFAULTS, mcp: { servers } });
    expect(config.mcp.servers).toStrictEqual(expected);
  });

  it("normalizes missing server lists while keeping empty args and ordered whitespace duplicates", () => {
    expect(parseMcpServers(undefined, "mcp.servers")).toStrictEqual([]);
    expect(parseMcpServers(null, "mcp.servers")).toStrictEqual([]);
    expect(parsedServer({
      name: "args-empty",
      transport: { ...STDIO, args: [] },
    }).transport).toStrictEqual({ ...STDIO, args: [] });
    expect(parsedServer({
      name: "args-fixture",
      transport: { ...STDIO, args: [" ", "--same", "--same"], cwd: " " },
    }).transport).toStrictEqual({
      ...STDIO,
      args: [" ", "--same", "--same"],
      cwd: " ",
    });
    expect(parseStringArrayOrNull(undefined, "args")).toBeNull();
    expect(parseStringArrayOrNull(null, "args")).toBeNull();
    expect(parseStringArrayOrNull([], "args")).toStrictEqual([]);
    expect(parseStringArrayOrNull([" ", "same", "same"], "args"))
      .toStrictEqual([" ", "same", "same"]);
  });

  it("uses RFC header tokens independently of environment identifier names", () => {
    expect(parsedServer({
      name: "headers-fixture",
      env: { _FIXTURE_2: "" },
      transport: {
        kind: "streamable_http",
        url: "https://example.invalid/mcp",
        headers: { "X-Fixture!": "", "X-Synthetic-Key": "synthetic-value" },
      },
    })).toStrictEqual({
      name: "headers-fixture",
      enabled: true,
      env: { _FIXTURE_2: "" },
      transport: {
        kind: "streamable_http",
        url: "https://example.invalid/mcp",
        headers: { "X-Fixture!": "", "X-Synthetic-Key": "synthetic-value" },
      },
    });
  });

  it("validates URL form while preserving bytes and existing non-HTTP schemes", () => {
    for (const url of [
      " https://example.invalid/mcp ",
      "file:///synthetic/path",
      "mailto:synthetic@example.invalid",
    ]) {
      expect(parseUrl(url, "endpoint")).toBe(url);
      expect(parsedServer({
        name: "url-fixture",
        transport: { kind: "sse", url },
      }).transport).toStrictEqual({ kind: "sse", url });
    }
  });

  it("wraps an indexed parser error through the existing add-server command", () => {
    const error = thrownError(() => parseAddServerJson(JSON.stringify({
      name: "args-fixture",
      transport: { ...STDIO, args: ["ok", ""] },
    })));
    expect(error).toBeInstanceOf(McpAddServerError);
    expect(error).not.toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({
      name: "McpAddServerError",
      message: 'mcp.servers[0].transport.args[1]: invalid config: mcp.servers[0].transport.args[1]: expected non-empty string, got ""',
    });
  });

  const invalidCases = [
    {
      label: "explicit enabled null",
      raw: [{ name: "enabled-fixture", enabled: null, transport: STDIO }],
      field: "mcp.servers[0].enabled",
      reason: "expected boolean, got null",
    },
    {
      label: "one-character namespace",
      raw: [{ name: "x", transport: STDIO }],
      field: "mcp.servers[0].name",
      reason: "name must match ^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$",
    },
    {
      label: "duplicate namespace at its second index",
      raw: [{ name: "same-fixture", transport: STDIO }, { name: "same-fixture", transport: STDIO }],
      field: "mcp.servers[1].name",
      reason: 'duplicate server name "same-fixture"',
    },
    {
      label: "namespace above the length ceiling",
      raw: [{ name: "a".repeat(33), transport: STDIO }],
      field: "mcp.servers[0].name",
      reason: "name exceeds 32 chars",
    },
    {
      label: "empty argument at its precise list index",
      raw: [{ name: "args-fixture", transport: { ...STDIO, args: ["ok", ""] } }],
      field: "mcp.servers[0].transport.args[1]",
      reason: 'expected non-empty string, got ""',
    },
    {
      label: "header-style environment key",
      raw: [{ name: "env-fixture", transport: STDIO, env: { "X-Fixture!": "synthetic-value" } }],
      field: "mcp.servers[0].env.X-Fixture!",
      reason: "env var name must match [A-Za-z_][A-Za-z0-9_]*",
    },
    {
      label: "non-token header name",
      raw: [{ name: "header-fixture", transport: { kind: "sse", url: "https://example.invalid/sse", headers: { "X Bad": "synthetic-value" } } }],
      field: "mcp.servers[0].transport.headers.X Bad",
      reason: "http header name must be a valid RFC 7230 token",
    },
    {
      label: "malformed remote URL with a valid server name",
      raw: [{ name: "url-fixture", transport: { kind: "streamable_http", url: "not a URL" } }],
      field: "mcp.servers[0].transport.url",
      reason: 'expected valid URL, got "not a URL"',
    },
  ];

  it.each(invalidCases)("keeps exact field/error identity for $label", ({ raw, field, reason }) => {
    const error = thrownError(() => parseMcpServers(raw, "mcp.servers"));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({
      name: "ConfigValidationError",
      field,
      reason,
      message: `invalid config: ${field}: ${reason}`,
    });
  });
});
