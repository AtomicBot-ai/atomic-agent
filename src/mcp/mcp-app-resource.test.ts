import { describe, expect, it, vi } from "vitest";

import { compressToolResult } from "../compressor/result-compressor.js";
import type { ToolContext } from "../tools/tool-registry.js";

import {
  attachMcpApp,
  carryMcpApp,
  MCP_APP_DETAIL,
  mcpAppRecordOf,
  mcpAppResourceUriOf,
  readMcpAppResource,
} from "./mcp-app-resource.js";
import { McpClient } from "./mcp-client.js";
import { McpRequestError } from "./mcp-errors.js";
import { createMcpToolDefinition } from "./mcp-tool-adapter.js";
import type { McpToolMeta } from "./mcp-types.js";

const PAGE = "<!doctype html><html><body><h1>Weather</h1></body></html>";
const MIME = "text/html;profile=mcp-app";

const signal = new AbortController().signal;

function readerOf(contents: unknown[] | (() => Promise<unknown>)) {
  const readResource = vi.fn(async (_uri: string, _signal: AbortSignal) =>
    typeof contents === "function" ? contents() : { contents },
  );
  return { readResource } as unknown as Pick<McpClient, "readResource"> & {
    readResource: typeof readResource;
  };
}

describe("mcpAppResourceUriOf", () => {
  it("reads _meta.ui.resourceUri", () => {
    expect(mcpAppResourceUriOf({ ui: { resourceUri: "ui://weather/card" } })).toBe("ui://weather/card");
  });

  it("falls back to the deprecated flat key", () => {
    expect(mcpAppResourceUriOf({ "ui/resourceUri": "ui://weather/card" })).toBe("ui://weather/card");
  });

  it("ignores anything that is not a ui:// URI", () => {
    expect(mcpAppResourceUriOf(undefined)).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: "file:///etc/passwd" } })).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: "https://evil.example/app.html" } })).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: "ui://" } })).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: "ui://a b" } })).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: 42 } })).toBeUndefined();
    expect(mcpAppResourceUriOf({ ui: { resourceUri: `ui://${"a".repeat(3000)}` } })).toBeUndefined();
  });
});

describe("readMcpAppResource", () => {
  it("returns the page with its byte count", async () => {
    const client = readerOf([{ uri: "ui://weather/card", mimeType: MIME, text: PAGE }]);
    const app = await readMcpAppResource(client, "weather", "ui://weather/card", "forecast", signal);
    expect(app).toEqual({
      server: "weather",
      uri: "ui://weather/card",
      title: "forecast",
      html: PAGE,
      bytes: Buffer.byteLength(PAGE, "utf8"),
    });
    expect(client.readResource).toHaveBeenCalledWith("ui://weather/card", expect.any(AbortSignal));
  });

  it("accepts the older text/html+mcp label and a base64 blob", async () => {
    const blob = Buffer.from(PAGE, "utf8").toString("base64");
    const client = readerOf([{ uri: "ui://w/c", mimeType: "text/html+mcp", blob }]);
    expect((await readMcpAppResource(client, "w", "ui://w/c", "t", signal))?.html).toBe(PAGE);
  });

  it("refuses non-HTML content, a missing mime type and empty pages", async () => {
    for (const entry of [
      { uri: "ui://w/c", mimeType: "application/json", text: "{}" },
      { uri: "ui://w/c", text: PAGE },
      { uri: "ui://w/c", mimeType: MIME, text: "   " },
      { uri: "ui://other", mimeType: MIME, text: PAGE },
    ]) {
      expect(await readMcpAppResource(readerOf([entry]), "w", "ui://w/c", "t", signal)).toBeUndefined();
    }
  });

  it("refuses a page over the size cap, text or blob", async () => {
    const big = "x".repeat(2048);
    const text = readerOf([{ uri: "ui://w/c", mimeType: MIME, text: big }]);
    expect(await readMcpAppResource(text, "w", "ui://w/c", "t", signal, { maxBytes: 1024 })).toBeUndefined();
    const blob = readerOf([{ uri: "ui://w/c", mimeType: MIME, blob: Buffer.from(big).toString("base64") }]);
    expect(await readMcpAppResource(blob, "w", "ui://w/c", "t", signal, { maxBytes: 1024 })).toBeUndefined();
  });

  it("never throws: a read error or a timeout is just no page", async () => {
    const failing = readerOf(async () => {
      throw new McpRequestError("w", "resources/read:ui://w/c", "boom");
    });
    expect(await readMcpAppResource(failing, "w", "ui://w/c", "t", signal)).toBeUndefined();

    const hanging = {
      readResource: (_uri: string, s: AbortSignal) =>
        new Promise((_resolve, reject) => s.addEventListener("abort", () => reject(new Error("aborted")))),
    } as unknown as Pick<McpClient, "readResource">;
    expect(await readMcpAppResource(hanging, "w", "ui://w/c", "t", signal, { timeoutMs: 20 })).toBeUndefined();
  });

  it("does not read a non-ui:// URI or after the call was aborted", async () => {
    const client = readerOf([{ uri: "https://x", mimeType: MIME, text: PAGE }]);
    expect(await readMcpAppResource(client, "w", "https://x", "t", signal)).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(await readMcpAppResource(client, "w", "ui://w/c", "t", aborted.signal)).toBeUndefined();
    expect(client.readResource).not.toHaveBeenCalled();
  });
});

describe("attachMcpApp / mcpAppRecordOf", () => {
  const app = { server: "w", uri: "ui://w/c", title: "t", html: PAGE, bytes: PAGE.length };

  it("keeps the page out of anything that serialises or copies details", () => {
    const details = attachMcpApp({ structuredContent: { temp: 21 } }, app);
    expect(JSON.stringify(details)).not.toContain("Weather");
    expect(Object.keys(details)).toEqual(["structuredContent"]);
    expect({ ...details }[MCP_APP_DETAIL]).toBeUndefined();
    expect(details[MCP_APP_DETAIL]).toBe(app);
  });

  it("is read back for an ok MCP call only", () => {
    const ok = compressToolResult({ tool: "mcp.w.forecast", status: "ok", output: "21C", details: attachMcpApp({}, app) });
    expect(mcpAppRecordOf(ok)).toEqual(app);
    expect(ok.summary).not.toContain("Weather");
    const failed = compressToolResult({ tool: "mcp.w.forecast", status: "error", output: "x", details: attachMcpApp({}, app) });
    expect(mcpAppRecordOf(failed)).toBeUndefined();
    const native = compressToolResult({ tool: "canvas.render", status: "ok", output: "x", details: attachMcpApp({}, app) });
    expect(mcpAppRecordOf(native)).toBeUndefined();
    const malformed = compressToolResult({ tool: "mcp.w.forecast", status: "ok", output: "x", details: attachMcpApp({}, { ...app, uri: "file:///x" }) });
    expect(mcpAppRecordOf(malformed)).toBeUndefined();
  });

  it("carryMcpApp moves the page onto a rebuilt details object", () => {
    const from = attachMcpApp({ a: 1 }, app);
    const to = carryMcpApp(from, { ...from, hookFeedback: "note" });
    expect(to[MCP_APP_DETAIL]).toBe(app);
    expect(Object.keys(to)).toEqual(["a", "hookFeedback"]);
  });
});

describe("MCP discovery keeps the tool's app URI", () => {
  it("stamps uiResourceUri from _meta.ui.resourceUri", async () => {
    const client = new McpClient({ name: "weather", enabled: true, transport: { kind: "stdio", command: "unused" } });
    (client as unknown as { client: unknown }).client = {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({
        tools: [
          { name: "forecast", _meta: { ui: { resourceUri: "ui://weather/card" } } },
          { name: "plain" },
          { name: "sneaky", _meta: { ui: { resourceUri: "file:///etc/passwd" } } },
        ],
      }),
    };
    const { tools } = await client.refreshCatalog();
    expect(tools.map((t) => [t.rawName, t.uiResourceUri])).toEqual([
      ["forecast", "ui://weather/card"],
      ["plain", undefined],
      ["sneaky", undefined],
    ]);
  });
});

describe("createMcpToolDefinition with an app", () => {
  const ctx: ToolContext = { workingDir: "/tmp", sessionId: "s-test", stepIndex: 0, signal };
  const meta: McpToolMeta = {
    server: "weather",
    rawName: "forecast",
    qualifiedName: "mcp.weather.forecast",
    description: "",
    inputSchema: { type: "object" },
    resourceClass: "approval_gated",
    uiResourceUri: "ui://weather/card",
  };

  function clientWith(readResource: (uri: string) => Promise<unknown>) {
    return {
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "21C and sunny" }] })),
      readResource: vi.fn(readResource),
    } as unknown as McpClient & { readResource: ReturnType<typeof vi.fn> };
  }

  it("puts the page on details and keeps it out of the model's summary", async () => {
    const client = clientWith(async () => ({ contents: [{ uri: "ui://weather/card", mimeType: MIME, text: PAGE }] }));
    const result = await createMcpToolDefinition(meta, client).run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("21C and sunny");
    expect(result.summary).not.toContain("<h1>");
    expect(JSON.stringify(result)).not.toContain("<h1>");
    expect(mcpAppRecordOf(result)).toMatchObject({ server: "weather", uri: "ui://weather/card", html: PAGE });
    expect(client.readResource).toHaveBeenCalledTimes(1);
  });

  it("a failed page read leaves the ok result as it was", async () => {
    const client = clientWith(async () => {
      throw new Error("resource gone");
    });
    const result = await createMcpToolDefinition(meta, client).run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("21C and sunny");
    expect(mcpAppRecordOf(result)).toBeUndefined();
  });

  it("does not read anything for a tool without an app", async () => {
    const { uiResourceUri: _drop, ...plain } = meta;
    const client = clientWith(async () => ({ contents: [] }));
    await createMcpToolDefinition(plain, client).run({}, ctx);
    expect(client.readResource).not.toHaveBeenCalled();
  });
});
