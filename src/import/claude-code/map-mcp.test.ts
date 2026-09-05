import { describe, expect, it } from "vitest";

import { mapClaudeCodeMcpServer } from "./map-mcp.js";

describe("mapClaudeCodeMcpServer", () => {
  it("maps a stdio entry, keeping args and env", () => {
    const result = mapClaudeCodeMcpServer({
      name: "gmail",
      raw: {
        type: "stdio",
        command: "npx",
        args: ["gmail-mcp", "--flag"],
        env: { TOKEN_PATH: "/tmp/t" },
      },
    });
    expect(result.kind).toBe("server");
    if (result.kind !== "server") return;
    expect(result.server.name).toBe("gmail");
    expect(result.server.transport).toMatchObject({
      kind: "stdio",
      command: "npx",
      args: ["gmail-mcp", "--flag"],
    });
    expect(result.server.env).toEqual({ TOKEN_PATH: "/tmp/t" });
  });

  it("maps http and sse url entries onto the matching transports", () => {
    const http = mapClaudeCodeMcpServer({
      name: "linear",
      raw: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(http.kind).toBe("server");
    if (http.kind === "server") {
      expect(http.server.transport).toMatchObject({
        kind: "streamable_http",
        url: "https://mcp.linear.app/mcp",
      });
    }

    const sse = mapClaudeCodeMcpServer({
      name: "old-school",
      raw: { type: "sse", url: "https://example.com/sse", headers: { A: "b" } },
    });
    expect(sse.kind).toBe("server");
    if (sse.kind === "server") {
      expect(sse.server.transport).toMatchObject({
        kind: "sse",
        url: "https://example.com/sse",
      });
    }
  });

  it("skips entries with neither command nor url", () => {
    const result = mapClaudeCodeMcpServer({ name: "weird", raw: { type: "ws" } });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.reason).toContain("no command or url");
    }
  });

  it("skips entries the canonical validator rejects", () => {
    const result = mapClaudeCodeMcpServer({
      name: "Bad Name With Spaces",
      raw: { command: "npx" },
    });
    expect(result.kind).toBe("skip");
  });
});
