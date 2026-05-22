import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McpAddServerError,
  McpRemoveServerError,
  parseAddServerJson,
  persistMcpServer,
  removeMcpServer,
} from "./persist-mcp-server.js";
import { resetConfigCache } from "../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("parseAddServerJson — bare object", () => {
  it("accepts a minimal stdio config", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "github",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@pkg/mcp"] },
      }),
    );
    expect(out.name).toBe("github");
    expect(out.enabled).toBe(true); // default
    expect(out.transport.kind).toBe("stdio");
  });

  it("normalises a streamable_http transport", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "docs",
        transport: { kind: "streamable_http", url: "https://example.com/mcp" },
      }),
    );
    expect(out.transport.kind).toBe("streamable_http");
  });

  it("accepts trust=pure_read", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "rofs",
        transport: { kind: "stdio", command: "/bin/ro-fs" },
        trust: "pure_read",
      }),
    );
    expect(out.trust).toBe("pure_read");
  });
});

describe("parseAddServerJson — mcpServers envelope", () => {
  it("unwraps a single-entry mcpServers object and uses the key as name", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          github: {
            transport: { kind: "stdio", command: "npx", args: ["pkg"] },
          },
        },
      }),
    );
    expect(out.name).toBe("github");
  });

  it("rejects mcpServers with zero entries", () => {
    expect(() =>
      parseAddServerJson(JSON.stringify({ mcpServers: {} })),
    ).toThrow(McpAddServerError);
  });

  it("rejects mcpServers with more than one entry", () => {
    expect(() =>
      parseAddServerJson(
        JSON.stringify({
          mcpServers: {
            a: { transport: { kind: "stdio", command: "x" } },
            b: { transport: { kind: "stdio", command: "y" } },
          },
        }),
      ),
    ).toThrow(/exactly one/);
  });

  it("rejects an inner-name mismatch", () => {
    expect(() =>
      parseAddServerJson(
        JSON.stringify({
          mcpServers: {
            outer: {
              name: "inner",
              transport: { kind: "stdio", command: "x" },
            },
          },
        }),
      ),
    ).toThrow(/name mismatch/);
  });

  it("accepts an inner-name that matches the envelope key", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          same: {
            name: "same",
            transport: { kind: "stdio", command: "x" },
          },
        },
      }),
    );
    expect(out.name).toBe("same");
  });
});

describe("parseAddServerJson — Claude Desktop / Cursor shortcut shape", () => {
  it("promotes top-level command + args into a stdio transport (envelope)", () => {
    // The exact shape pasted from Claude Desktop / mcp.json docs —
    // no `transport` wrapper, `command` + `args` inline.
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          airbnb: {
            command: "npx",
            args: ["-y", "@openbnb/mcp-server-airbnb"],
          },
        },
      }),
    );
    expect(out.name).toBe("airbnb");
    expect(out.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@openbnb/mcp-server-airbnb"],
    });
  });

  it("promotes top-level command in a bare object too", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "airbnb",
        command: "npx",
        args: ["-y", "@openbnb/mcp-server-airbnb"],
      }),
    );
    expect(out.transport.kind).toBe("stdio");
    if (out.transport.kind === "stdio") {
      expect(out.transport.command).toBe("npx");
    }
  });

  it("carries through env and cwd from the shortcut form", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "/usr/local/bin/mcp",
            cwd: "/tmp/work",
            env: { GITHUB_TOKEN: "abc" },
          },
        },
      }),
    );
    if (out.transport.kind === "stdio") {
      expect(out.transport.cwd).toBe("/tmp/work");
    }
    expect(out.env).toEqual({ GITHUB_TOKEN: "abc" });
  });

  it("promotes top-level url into streamable_http", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://example.com/mcp" },
        },
      }),
    );
    expect(out.transport).toEqual({
      kind: "streamable_http",
      url: "https://example.com/mcp",
    });
  });

  it("accepts serverUrl as a synonym for url (Smithery / DeepWiki dialect)", () => {
    // Exact paste from the DeepWiki MCP listing — `serverUrl` instead
    // of `url`, no `transport` block, no `type`.
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          deepwiki: { serverUrl: "https://mcp.deepwiki.com/mcp" },
        },
      }),
    );
    expect(out.name).toBe("deepwiki");
    expect(out.transport).toEqual({
      kind: "streamable_http",
      url: "https://mcp.deepwiki.com/mcp",
    });
  });

  it("accepts serverUrl in a bare object too", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "deepwiki",
        serverUrl: "https://mcp.deepwiki.com/mcp",
      }),
    );
    if (out.transport.kind === "streamable_http") {
      expect(out.transport.url).toBe("https://mcp.deepwiki.com/mcp");
    }
  });

  it("serverUrl + type=sse resolves to SSE transport", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          live: { serverUrl: "https://example.com/sse", type: "sse" },
        },
      }),
    );
    expect(out.transport.kind).toBe("sse");
  });

  it("url wins over serverUrl when both are present", () => {
    // Both keys at once is unusual but should be defined behaviour —
    // explicit `url` is the canonical key, `serverUrl` is the dialect.
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          conflict: {
            url: "https://canonical.example.com/mcp",
            serverUrl: "https://dialect.example.com/mcp",
          },
        },
      }),
    );
    if (out.transport.kind === "streamable_http") {
      expect(out.transport.url).toBe("https://canonical.example.com/mcp");
    }
  });

  it("promotes top-level url into SSE when type=sse", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://example.com/sse", type: "sse" },
        },
      }),
    );
    expect(out.transport.kind).toBe("sse");
  });

  it("explicit transport wins over a stray top-level command", () => {
    const out = parseAddServerJson(
      JSON.stringify({
        name: "explicit",
        command: "should-be-ignored",
        transport: { kind: "stdio", command: "the-real-one" },
      }),
    );
    if (out.transport.kind === "stdio") {
      expect(out.transport.command).toBe("the-real-one");
    }
  });
});

describe("parseAddServerJson — failure surface", () => {
  it("rejects empty input", () => {
    expect(() => parseAddServerJson("")).toThrow(/empty/);
    expect(() => parseAddServerJson("   \n\n  ")).toThrow(/empty/);
  });

  it("rejects malformed JSON with a helpful message", () => {
    expect(() => parseAddServerJson("{not json")).toThrow(/invalid JSON/);
  });

  it("rejects non-objects (arrays / primitives)", () => {
    expect(() => parseAddServerJson("[1,2,3]")).toThrow(/JSON object/);
    expect(() => parseAddServerJson('"a-string"')).toThrow(/JSON object/);
    expect(() => parseAddServerJson("42")).toThrow(/JSON object/);
  });

  it("surfaces schema validation errors (invalid transport)", () => {
    expect(() =>
      parseAddServerJson(
        JSON.stringify({ name: "x", transport: { kind: "bogus" } }),
      ),
    ).toThrow(McpAddServerError);
  });

  it("surfaces name-regex violations", () => {
    expect(() =>
      parseAddServerJson(
        JSON.stringify({
          name: "INVALID NAME",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    ).toThrow();
  });
});

describe("persistMcpServer — writes config.json and merges", () => {
  let stateDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mcp-persist-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = {
      [STATE_DIR_ENV]: process.env[STATE_DIR_ENV],
    };
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("appends a new server entry to config.mcp.servers", () => {
    const server = parseAddServerJson(
      JSON.stringify({
        name: "first",
        transport: { kind: "stdio", command: "npx", args: ["pkg"] },
      }),
    );
    const result = persistMcpServer(server);
    expect(result.totalServers).toBe(1);
    expect(result.server.name).toBe("first");
    const onDisk = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(onDisk.mcp.servers).toHaveLength(1);
    expect(onDisk.mcp.servers[0].name).toBe("first");
  });

  it("appends additional entries while preserving existing ones", () => {
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "first",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    );
    const result = persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "second",
          transport: { kind: "stdio", command: "y" },
        }),
      ),
    );
    expect(result.totalServers).toBe(2);
    const onDisk = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(onDisk.mcp.servers.map((s: { name: string }) => s.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects a duplicate name without touching the file", () => {
    const server = parseAddServerJson(
      JSON.stringify({
        name: "dupe",
        transport: { kind: "stdio", command: "x" },
      }),
    );
    persistMcpServer(server);
    const path = join(stateDir, "config.json");
    const before = readFileSync(path, "utf8");
    expect(() => persistMcpServer(server)).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("creates the config file from defaults when missing", () => {
    // No config.json yet — only the empty stateDir exists. The persist
    // path must materialise defaults + the new server in one shot.
    const path = join(stateDir, "config.json");
    expect(() => readFileSync(path, "utf8")).toThrow();
    const result = persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "fresh",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    );
    const onDisk = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(onDisk.mcp.servers).toHaveLength(1);
    expect(typeof onDisk.version).toBe("number");
  });

  it("removes an existing server by name", () => {
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "keep-me",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    );
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "drop-me",
          transport: { kind: "stdio", command: "y" },
        }),
      ),
    );
    const result = removeMcpServer("drop-me");
    expect(result.removed).toBe("drop-me");
    expect(result.totalServers).toBe(1);
    const onDisk = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(onDisk.mcp.servers.map((s: { name: string }) => s.name)).toEqual([
      "keep-me",
    ]);
  });

  it("rejects removing a server that does not exist", () => {
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "only-one",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    );
    expect(() => removeMcpServer("missing")).toThrow(McpRemoveServerError);
  });

  it("rejects an empty name", () => {
    expect(() => removeMcpServer("   ")).toThrow(/empty/);
  });

  it("trims whitespace from the input name", () => {
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "with-spaces",
          transport: { kind: "stdio", command: "x" },
        }),
      ),
    );
    const result = removeMcpServer("  with-spaces  ");
    expect(result.removed).toBe("with-spaces");
    expect(result.totalServers).toBe(0);
  });

  it("preserves unrelated top-level config sections (telegram, memory, etc.)", () => {
    // Pre-populate a config.json with a non-default telegram block.
    const path = join(stateDir, "config.json");
    // v5 is the oldest version still accepted by parseUserConfigFile;
    // ensureUserConfigFileSync migrates it transparently to the current
    // schema while preserving user-set values.
    const seed = {
      version: 5,
      telegram: { enabled: true, ownerUserId: 12345 },
    };
    writeFileSync(path, JSON.stringify(seed), "utf8");
    persistMcpServer(
      parseAddServerJson(
        JSON.stringify({
          name: "first-server",
          transport: { kind: "stdio", command: "c" },
        }),
      ),
    );
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.telegram.enabled).toBe(true);
    expect(onDisk.telegram.ownerUserId).toBe(12345);
    expect(onDisk.mcp.servers).toHaveLength(1);
  });
});
