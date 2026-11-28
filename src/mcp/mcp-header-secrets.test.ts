import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolSecretSource } from "../config/tool-secrets.js";
import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { McpClient } from "./mcp-client.js";
import { McpConnectError } from "./mcp-errors.js";
import { resolveMcpServerHeaders } from "./mcp-header-secrets.js";
import type { McpServerConfig } from "./mcp-types.js";

// `{{secret:NAME}}` in a remote MCP server's headers, filled in at connect (ATO-2530).

const VALUE = "Hdr7Secret8Value9Qrst";

function source(resolved: string[] = [], value = VALUE): ToolSecretSource {
  return {
    has: (name) => name === "LINEAR_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return value;
    },
  };
}

function remote(headers: Record<string, string> | undefined, url = "https://mcp.example.com/mcp"): McpServerConfig {
  return {
    name: "linear",
    enabled: true,
    transport: { kind: "streamable_http", url, ...(headers ? { headers } : {}) },
  } as McpServerConfig;
}

afterEach(() => resetResolvedSecretValues());

describe("resolveMcpServerHeaders", () => {
  it("fills placeholders in header values and leaves other headers alone", async () => {
    const headers = await resolveMcpServerHeaders(
      remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}", "X-Team": "core" }),
      source(),
    );
    expect(headers).toEqual({ Authorization: `Bearer ${VALUE}`, "X-Team": "core" });
  });

  it("has nothing to do for a stdio server or a remote one without headers", async () => {
    expect(await resolveMcpServerHeaders(remote(undefined), source())).toBeUndefined();
    const stdio = { name: "s", enabled: true, transport: { kind: "stdio", command: "x" } } as McpServerConfig;
    expect(await resolveMcpServerHeaders(stdio, source())).toBeUndefined();
  });

  it("refuses a secret to a server the person did not add (an installed plugin's)", async () => {
    const resolved: string[] = [];
    const err = await resolveMcpServerHeaders(
      remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}" }),
      source(resolved),
      false,
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectError);
    expect((err as Error).message).toContain("installed plugin");
    expect((err as Error).message).toContain("not connected");
    // Nothing was fetched for it.
    expect(resolved).toEqual([]);
    // A plugin server without placeholders is unaffected.
    await expect(resolveMcpServerHeaders(remote({ "X-Team": "core" }), source(), false)).resolves.toEqual({
      "X-Team": "core",
    });
  });

  it("keeps the server down with the secret's name, never a value", async () => {
    for (const value of ["Bearer {{secret:OTHER}}", "Bearer {{secret:bad-name}}"]) {
      const err = await resolveMcpServerHeaders(remote({ Authorization: value }), source()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpConnectError);
    }
    const none = await resolveMcpServerHeaders(remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}" }), undefined).then(
      () => null,
      (e: unknown) => e,
    );
    expect((none as Error).message).toContain("unknown secret LINEAR_TOKEN");
  });

  it("refuses a value with a line break, which would start a header of its own", async () => {
    const err = await resolveMcpServerHeaders(
      remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}" }),
      source([], "abc\r\nX-Evil: 1"),
    ).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toContain("line break");
    expect((err as Error).message).not.toContain("X-Evil");
  });
});

describe("McpClient remote headers with a tool secret", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  async function listen(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = [];
    server = createServer((req, res) => {
      seen.push(req.headers);
      // Echo the header back in the error body: the connect error must mask it.
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`refused auth=${req.headers.authorization ?? ""}`);
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/mcp`, seen };
  }

  it("sends the value, not the placeholder, and masks it in the connect error", async () => {
    const { url, seen } = await listen();
    const client = new McpClient(remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}" }, url), {
      toolSecrets: source(),
    });
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpConnectError);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.authorization).toBe(`Bearer ${VALUE}`);
    expect((err as Error).message).not.toContain(VALUE);
  }, 20_000);

  it("never connects a plugin's server that names a secret", async () => {
    const { url, seen } = await listen();
    const transportFactory = vi.fn();
    const client = new McpClient(remote({ Authorization: "Bearer {{secret:LINEAR_TOKEN}}" }, url), {
      toolSecrets: source(),
      mayUseToolSecrets: () => false,
      transportFactory,
    });
    await expect(client.connect()).rejects.toThrow(/installed plugin/);
    expect(transportFactory).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
