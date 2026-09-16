import { describe, expect, it } from "vitest";

import { mapOhMyPiMcpServer } from "./map-mcp.js";
import type { OhMyPiMcpServer } from "./oh-my-pi-source.js";

function entry(partial: Partial<OhMyPiMcpServer>): OhMyPiMcpServer {
  return { name: "server", raw: {}, disabled: false, ...partial };
}

describe("mapOhMyPiMcpServer", () => {
  it("maps a stdio server with args, cwd and env", () => {
    const result = mapOhMyPiMcpServer(
      entry({
        name: "files",
        raw: {
          command: "npx",
          args: ["-y", "server-filesystem"],
          cwd: "/work",
          env: { TOKEN: "t" },
          timeout: 30_000,
          requestIdFormat: "string",
        },
      }),
    );
    expect(result).toEqual({
      kind: "server",
      server: {
        name: "files",
        enabled: true,
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "server-filesystem"],
          cwd: "/work",
        },
        env: { TOKEN: "t" },
      },
    });
  });

  it("maps http to streamable_http and sse to sse", () => {
    const http = mapOhMyPiMcpServer(
      entry({
        name: "remote",
        raw: {
          type: "http",
          url: "https://mcp.example.com/x",
          headers: { Authorization: "Bearer t" },
        },
      }),
    );
    if (http.kind !== "server") throw new Error("expected server");
    expect(http.server.transport).toEqual({
      kind: "streamable_http",
      url: "https://mcp.example.com/x",
      headers: { Authorization: "Bearer t" },
    });

    const sse = mapOhMyPiMcpServer(
      entry({ name: "events", raw: { type: "sse", url: "https://e.dev/s" } }),
    );
    if (sse.kind !== "server") throw new Error("expected server");
    expect(sse.server.transport).toEqual({
      kind: "sse",
      url: "https://e.dev/s",
    });
  });

  it("imports a disabled server as enabled: false", () => {
    const result = mapOhMyPiMcpServer(
      entry({ name: "paused", raw: { command: "npx" }, disabled: true }),
    );
    if (result.kind !== "server") throw new Error("expected server");
    expect(result.server.enabled).toBe(false);
  });

  it("skips entries without command or url", () => {
    const result = mapOhMyPiMcpServer(entry({ raw: { oauth: {} } }));
    expect(result).toMatchObject({ kind: "skip" });
    if (result.kind !== "skip") return;
    expect(result.reason).toMatch(/no command or url/);
  });

  it("skips names the canonical validator rejects", () => {
    const result = mapOhMyPiMcpServer(
      entry({ name: "Bad Name!", raw: { command: "npx" } }),
    );
    expect(result).toMatchObject({ kind: "skip" });
  });
});
