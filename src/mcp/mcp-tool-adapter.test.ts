import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import { McpRequestError } from "./mcp-errors.js";
import {
  createMcpToolDefinition,
  extractStructuredDetails,
  projectMcpResponseToText,
} from "./mcp-tool-adapter.js";
import type { McpToolMeta } from "./mcp-types.js";

function metaOf(
  server: string,
  rawName: string,
  overrides: Partial<McpToolMeta> = {},
): McpToolMeta {
  return {
    server,
    rawName,
    qualifiedName: `mcp.${server}.${rawName}`,
    description: "",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function fakeClient(
  callTool: (rawName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): McpClient {
  // Duck-typed minimal stub — only callTool is exercised by the adapter.
  return { callTool } as unknown as McpClient;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "s-test",
  stepIndex: 0,
  signal: new AbortController().signal,
};

describe("projectMcpResponseToText", () => {
  it("returns empty string for null / non-object input", () => {
    expect(projectMcpResponseToText(null)).toBe("");
    expect(projectMcpResponseToText("hi")).toBe("");
    expect(projectMcpResponseToText(undefined)).toBe("");
  });

  it("concatenates text content blocks", () => {
    const out = projectMcpResponseToText({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(out).toBe("first\nsecond");
  });

  it("renders image / audio / resource / resource_link blocks as one-line markers", () => {
    const out = projectMcpResponseToText({
      content: [
        { type: "image", mimeType: "image/png" },
        { type: "audio", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///foo" } },
        { type: "resource_link", uri: "https://example.com" },
        { type: "weird", text: "ignored" },
      ],
    });
    expect(out).toBe(
      "[image image/png]\n[audio audio/wav]\n[resource file:///foo]\n[resource_link https://example.com]\n[weird]",
    );
  });

  it("renders legacy `toolResult` shape as JSON", () => {
    const out = projectMcpResponseToText({ toolResult: { ok: true, count: 3 } });
    expect(out).toBe('{"ok":true,"count":3}');
  });

  it("clips long text with a [truncated] marker", () => {
    const huge = "x".repeat(20_000);
    const out = projectMcpResponseToText({
      content: [{ type: "text", text: huge }],
    });
    expect(out.length).toBeLessThan(huge.length);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});

describe("extractStructuredDetails", () => {
  it("forwards structuredContent and _meta verbatim", () => {
    const details = extractStructuredDetails({
      structuredContent: { ok: true, items: [1, 2] },
      _meta: { trace: "abc" },
    });
    expect(details.structuredContent).toEqual({ ok: true, items: [1, 2] });
    expect(details.meta).toEqual({ trace: "abc" });
  });

  it("returns an empty object for non-object input", () => {
    expect(extractStructuredDetails(null)).toEqual({});
    expect(extractStructuredDetails("hi")).toEqual({});
  });

  it("skips missing structuredContent / _meta gracefully", () => {
    expect(extractStructuredDetails({ content: [] })).toEqual({});
  });
});

describe("createMcpToolDefinition", () => {
  it("uses the qualified name and synthesises a description when blank", () => {
    const def = createMcpToolDefinition(
      metaOf("github", "list_repos"),
      fakeClient(async () => ({ content: [] })),
    );
    expect(def.name).toBe("mcp.github.list_repos");
    expect(def.description).toBe("MCP tool list_repos on github");
  });

  it("preserves the meta description when present", () => {
    const def = createMcpToolDefinition(
      metaOf("docs", "search", { description: "Search the docs." }),
      fakeClient(async () => ({ content: [] })),
    );
    expect(def.description).toBe("Search the docs.");
  });

  it("readonly is true when readOnlyHint is true", () => {
    const def = createMcpToolDefinition(
      metaOf("docs", "search", { annotations: { readOnlyHint: true } }),
      fakeClient(async () => ({ content: [] })),
    );
    expect(def.readonly).toBe(true);
  });

  it("readonly is true when destructiveHint is false", () => {
    const def = createMcpToolDefinition(
      metaOf("docs", "search", { annotations: { destructiveHint: false } }),
      fakeClient(async () => ({ content: [] })),
    );
    expect(def.readonly).toBe(true);
  });

  it("readonly defaults to false when no hints are provided", () => {
    const def = createMcpToolDefinition(
      metaOf("github", "create_issue"),
      fakeClient(async () => ({ content: [] })),
    );
    expect(def.readonly).toBe(false);
  });

  it("forwards args verbatim to client.callTool", async () => {
    let received: { rawName: string; args: Record<string, unknown> } | null = null;
    const def = createMcpToolDefinition(
      metaOf("github", "create_issue"),
      fakeClient(async (rawName, args) => {
        received = { rawName, args };
        return { content: [{ type: "text", text: "ok" }] };
      }),
    );
    await def.run({ title: "Bug", body: "broken" }, ctx);
    expect(received).toEqual({
      rawName: "create_issue",
      args: { title: "Bug", body: "broken" },
    });
  });

  it("returns a compressed status=ok result on success", async () => {
    const def = createMcpToolDefinition(
      metaOf("docs", "search"),
      fakeClient(async () => ({
        content: [{ type: "text", text: "result body" }],
        structuredContent: { hits: 3 },
      })),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("result body");
    expect(result.details?.structuredContent).toEqual({ hits: 3 });
  });

  it("folds McpRequestError into a status=error result (never throws)", async () => {
    const def = createMcpToolDefinition(
      metaOf("github", "create_issue"),
      fakeClient(async () => {
        throw new McpRequestError("github", "tools/call", "rate limited");
      }),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("rate limited");
    expect(result.details).toMatchObject({
      server: "github",
      rawName: "create_issue",
    });
  });

  it("folds arbitrary thrown errors into a status=error result", async () => {
    const def = createMcpToolDefinition(
      metaOf("github", "create_issue"),
      fakeClient(async () => {
        throw new Error("transport blew up");
      }),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("transport blew up");
  });
});
