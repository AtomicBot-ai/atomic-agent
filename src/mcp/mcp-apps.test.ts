import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractMcpAppUi,
  fetchMcpAppUi,
  isMcpAppMimeType,
  isModelVisibleTool,
  MCP_APP_FETCH_TIMEOUT_MS,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION_ID,
  mcpAppsClientExtension,
  parseToolUiMeta,
  withoutMcpAppPage,
} from "./mcp-apps.js";
import { clientCapabilities, McpClient } from "./mcp-client.js";
import { createMcpToolDefinition } from "./mcp-tool-adapter.js";
import type { McpToolMeta } from "./mcp-types.js";
import type { ToolContext } from "../tools/tool-registry.js";

const PAGE = "<!doctype html><html><body><div id=app></div><script>/*app*/</script></body></html>";

function readResult(over: Record<string, unknown> = {}) {
  return {
    contents: [{ uri: "ui://weather/view.html", mimeType: MCP_APP_MIME_TYPE, text: PAGE, ...over }],
  };
}

describe("parseToolUiMeta", () => {
  it("reads _meta.ui.resourceUri and visibility", () => {
    expect(
      parseToolUiMeta({ ui: { resourceUri: "ui://weather/view.html", visibility: ["model", "app"] } }),
    ).toEqual({ resourceUri: "ui://weather/view.html", visibility: ["model", "app"] });
  });

  it("accepts the deprecated flat key", () => {
    expect(parseToolUiMeta({ "ui/resourceUri": "ui://weather/view.html" })).toEqual({
      resourceUri: "ui://weather/view.html",
    });
  });

  it("ignores non-ui:// URIs and malformed metadata", () => {
    expect(parseToolUiMeta(undefined)).toBeUndefined();
    expect(parseToolUiMeta({ ui: { resourceUri: "https://evil.example/x.html" } })).toBeUndefined();
    expect(parseToolUiMeta({ ui: { resourceUri: "ui://" } })).toBeUndefined();
    expect(parseToolUiMeta({ ui: { resourceUri: "ui://a\nb" } })).toBeUndefined();
    expect(parseToolUiMeta({ ui: { resourceUri: 42 } })).toBeUndefined();
    expect(parseToolUiMeta({ ui: "ui://x" })).toBeUndefined();
  });

  it("drops a visibility list with unknown entries but keeps the page", () => {
    expect(parseToolUiMeta({ ui: { resourceUri: "ui://a/b", visibility: ["model", "everyone"] } })).toEqual({
      resourceUri: "ui://a/b",
    });
  });

  it("keeps app-only visibility even without a usable page", () => {
    expect(parseToolUiMeta({ ui: { visibility: ["app"] } })).toEqual({ visibility: ["app"] });
  });
});

describe("isModelVisibleTool", () => {
  it("hides only tools whose visibility leaves out the model", () => {
    expect(isModelVisibleTool(undefined)).toBe(true);
    expect(isModelVisibleTool({ resourceUri: "ui://a/b" })).toBe(true);
    expect(isModelVisibleTool({ visibility: ["model"] })).toBe(true);
    expect(isModelVisibleTool({ visibility: ["app"] })).toBe(false);
    expect(isModelVisibleTool({ visibility: [] })).toBe(false);
  });
});

describe("isMcpAppMimeType", () => {
  it("matches the app profile only, without case or spacing", () => {
    expect(isMcpAppMimeType("text/html;profile=mcp-app")).toBe(true);
    expect(isMcpAppMimeType("TEXT/HTML; profile=mcp-app")).toBe(true);
    expect(isMcpAppMimeType("text/html")).toBe(false);
    expect(isMcpAppMimeType("text/html+skybridge")).toBe(false);
    expect(isMcpAppMimeType(undefined)).toBe(false);
  });
});

describe("extractMcpAppUi", () => {
  it("returns the page with its sandbox requests", () => {
    const ui = extractMcpAppUi(
      "ui://weather/view.html",
      readResult({
        _meta: {
          ui: {
            csp: { connectDomains: ["https://api.weather.example"], resourceDomains: ["https://cdn.example", 7, "a b"] },
            permissions: { clipboardWrite: {}, camera: false },
            domain: "weather.apps.example",
            prefersBorder: true,
          },
        },
      }),
    );
    expect(ui).toEqual({
      resourceUri: "ui://weather/view.html",
      mimeType: MCP_APP_MIME_TYPE,
      html: PAGE,
      csp: { connectDomains: ["https://api.weather.example"], resourceDomains: ["https://cdn.example"] },
      permissions: { clipboardWrite: true },
      domain: "weather.apps.example",
      prefersBorder: true,
    });
  });

  it("decodes a base64 blob", () => {
    const blob = Buffer.from(PAGE, "utf8").toString("base64");
    const ui = extractMcpAppUi("ui://weather/view.html", readResult({ text: undefined, blob }));
    expect(ui?.html).toBe(PAGE);
  });

  it("refuses another mimeType, an empty page and a missing item", () => {
    expect(extractMcpAppUi("ui://weather/view.html", readResult({ mimeType: "text/html" }))).toBeUndefined();
    expect(extractMcpAppUi("ui://weather/view.html", readResult({ text: "  " }))).toBeUndefined();
    expect(extractMcpAppUi("ui://weather/view.html", { contents: [] })).toBeUndefined();
    expect(extractMcpAppUi("ui://weather/view.html", null)).toBeUndefined();
    expect(
      extractMcpAppUi("ui://weather/view.html", {
        contents: [
          { uri: "ui://other/a", mimeType: MCP_APP_MIME_TYPE, text: PAGE },
          { uri: "ui://other/b", mimeType: MCP_APP_MIME_TYPE, text: PAGE },
        ],
      }),
    ).toBeUndefined();
  });

  it("refuses a page over the byte cap, as text or as blob", () => {
    const big = "x".repeat(101);
    expect(extractMcpAppUi("ui://weather/view.html", readResult({ text: big }), 100)).toBeUndefined();
    const blob = Buffer.from(big).toString("base64");
    expect(extractMcpAppUi("ui://weather/view.html", readResult({ text: undefined, blob }), 100)).toBeUndefined();
    expect(extractMcpAppUi("ui://weather/view.html", readResult({ text: "x".repeat(100) }), 100)?.html).toHaveLength(100);
  });
});

describe("fetchMcpAppUi", () => {
  it("never throws: a failed read means no page", async () => {
    const client = { readResource: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(fetchMcpAppUi(client, "ui://a/b", new AbortController().signal)).resolves.toBeUndefined();
  });

  it("does not read once the turn is aborted", async () => {
    const client = { readResource: vi.fn(async () => readResult()) };
    const ac = new AbortController();
    ac.abort();
    await expect(fetchMcpAppUi(client, "ui://weather/view.html", ac.signal)).resolves.toBeUndefined();
    expect(client.readResource).not.toHaveBeenCalled();
  });

  it("gives up after its own short deadline and aborts the read", async () => {
    let seen: AbortSignal | undefined;
    const client = {
      readResource: vi.fn((_uri: string, signal: AbortSignal) => {
        seen = signal;
        return new Promise<Record<string, unknown>>(() => {});
      }),
    };
    const started = Date.now();
    await expect(
      fetchMcpAppUi(client, "ui://weather/view.html", new AbortController().signal, undefined, 20),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen?.aborted).toBe(true);
  });

  it("stops waiting when the turn is aborted mid-read", async () => {
    const client = { readResource: vi.fn(() => new Promise<Record<string, unknown>>(() => {})) };
    const ac = new AbortController();
    const pending = fetchMcpAppUi(client, "ui://weather/view.html", ac.signal);
    ac.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it("keeps its deadline well under the 60 s request deadline", () => {
    expect(MCP_APP_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("withoutMcpAppPage", () => {
  it("drops only the page and leaves the input object alone", () => {
    const details = { structuredContent: { temp: 21 }, mcpApp: { html: "<p>x</p>" } };
    expect(withoutMcpAppPage(details)).toEqual({ structuredContent: { temp: 21 } });
    expect(details.mcpApp.html).toBe("<p>x</p>");
  });
});

describe("clientCapabilities and MCP Apps", () => {
  it("advertises the ui extension only when the host renders apps", () => {
    expect(clientCapabilities({})).toEqual({});
    expect(clientCapabilities({ appsUi: true })).toEqual({
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
    });
    expect(mcpAppsClientExtension()).toEqual({ "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } });
  });
});

describe("McpClient discovery with MCP Apps", () => {
  function clientWithTools(tools: Array<Record<string, unknown>>): McpClient {
    const client = new McpClient({
      name: "weather",
      enabled: true,
      transport: { kind: "stdio", command: "unused" },
    });
    (client as unknown as { client: unknown }).client = {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({ tools }),
    };
    return client;
  }

  it("keeps a tool's page and drops app-only tools from the agent's list", async () => {
    const catalog = await clientWithTools([
      { name: "get_forecast", _meta: { ui: { resourceUri: "ui://weather/view.html" } } },
      { name: "refresh_view", _meta: { ui: { resourceUri: "ui://weather/view.html", visibility: ["app"] } } },
      { name: "plain" },
    ]).refreshCatalog();
    expect(catalog.tools.map((t) => t.rawName)).toEqual(["get_forecast", "plain"]);
    expect(catalog.tools[0]!.ui).toEqual({ resourceUri: "ui://weather/view.html" });
    expect(catalog.tools[1]!.ui).toBeUndefined();
  });
});

describe("createMcpToolDefinition with an MCP App", () => {
  const ctx: ToolContext = {
    workingDir: "/tmp",
    sessionId: "s-test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
  const meta = (over: Partial<McpToolMeta> = {}): McpToolMeta => ({
    server: "weather",
    rawName: "get_forecast",
    qualifiedName: "mcp.weather.get_forecast",
    description: "",
    inputSchema: { type: "object" },
    resourceClass: "approval_gated",
    ui: { resourceUri: "ui://weather/view.html" },
    ...over,
  });
  const callResult = { content: [{ type: "text", text: "Sunny, 21C" }], structuredContent: { temp: 21 } };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches the page to details, never to the summary the model reads", async () => {
    const readResource = vi.fn(async () => readResult());
    const client = { appsUi: true, callTool: async () => callResult, readResource } as unknown as McpClient;
    const res = await createMcpToolDefinition(meta(), client).run({ city: "Tallinn" }, ctx);

    expect(res.status).toBe("ok");
    expect(readResource).toHaveBeenCalledWith("ui://weather/view.html", expect.any(AbortSignal));
    expect(res.details.mcpApp).toEqual({
      resourceUri: "ui://weather/view.html",
      mimeType: MCP_APP_MIME_TYPE,
      html: PAGE,
      toolInput: { city: "Tallinn" },
      toolResult: { content: callResult.content, structuredContent: { temp: 21 } },
    });
    expect(res.summary).not.toContain("<script>");
    expect(res.summary).not.toContain("ui://");
  });

  it("returns the plain result when the page cannot be read", async () => {
    const client = {
      appsUi: true,
      callTool: async () => callResult,
      readResource: async () => readResult({ mimeType: "text/html" }),
    } as unknown as McpClient;
    const res = await createMcpToolDefinition(meta(), client).run({}, ctx);
    expect(res.status).toBe("ok");
    expect(res.details).not.toHaveProperty("mcpApp");
  });

  it("does not read any resource for a tool without a page, or after a failed call", async () => {
    const readResource = vi.fn(async () => readResult());
    const ok = { appsUi: true, callTool: async () => callResult, readResource } as unknown as McpClient;
    await createMcpToolDefinition(meta({ ui: undefined }), ok).run({}, ctx);
    const failing = {
      appsUi: true,
      callTool: async () => { throw new Error("down"); },
      readResource,
    } as unknown as McpClient;
    const res = await createMcpToolDefinition(meta(), failing).run({}, ctx);
    expect(res.status).toBe("error");
    expect(readResource).not.toHaveBeenCalled();
  });

  it("does not read the page when the host does not render MCP Apps", async () => {
    const readResource = vi.fn(async () => readResult());
    const client = { appsUi: false, callTool: async () => callResult, readResource } as unknown as McpClient;
    const res = await createMcpToolDefinition(meta(), client).run({}, ctx);
    expect(res.status).toBe("ok");
    expect(readResource).not.toHaveBeenCalled();
    expect(res.details).not.toHaveProperty("mcpApp");
  });

  it("returns the tool result when the page read never answers", async () => {
    vi.useFakeTimers();
    const readResource = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
    const client = { appsUi: true, callTool: async () => callResult, readResource } as unknown as McpClient;
    const pending = createMcpToolDefinition(meta(), client).run({}, ctx);
    await vi.advanceTimersByTimeAsync(MCP_APP_FETCH_TIMEOUT_MS + 1);
    const res = await pending;
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("ok");
    expect(res.details).not.toHaveProperty("mcpApp");
  });
});
