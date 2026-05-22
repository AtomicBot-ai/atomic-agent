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

  it("renders legacy `toolResult` shape as pretty-printed JSON", () => {
    const out = projectMcpResponseToText({ toolResult: { ok: true, count: 3 } });
    expect(out).toBe('{\n  "ok": true,\n  "count": 3\n}');
  });

  it("prefers structuredContent over content text blocks when both are present", () => {
    // Per MCP spec, structuredContent matches the tool's declared
    // outputSchema and is the canonical typed payload. The content
    // text blocks are typically a human-readable mirror — preferring
    // the typed form gives the agent line-structured JSON that the
    // compressor can clip cleanly between records.
    const out = projectMcpResponseToText({
      content: [{ type: "text", text: "human-friendly mirror" }],
      structuredContent: { hits: 3, items: ["a", "b"] },
    });
    expect(out).toContain('"hits": 3');
    expect(out).toContain('"items"');
    expect(out).not.toContain("human-friendly mirror");
  });

  it("falls back to content blocks when structuredContent is missing", () => {
    const out = projectMcpResponseToText({
      content: [{ type: "text", text: "no structured payload here" }],
    });
    expect(out).toBe("no structured payload here");
  });

  it("falls back to content blocks when structuredContent cannot be serialised", () => {
    // Cyclic object — JSON.stringify throws; the projector must not
    // crash and should surface the content text instead.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = projectMcpResponseToText({
      structuredContent: cyclic,
      content: [{ type: "text", text: "fallback text" }],
    });
    expect(out).toBe("fallback text");
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
    // structuredContent wins over content text blocks (see
    // projectMcpResponseToText invariant).
    expect(result.summary).toContain('"hits": 3');
    expect(result.details?.structuredContent).toEqual({ hits: 3 });
  });

  it("returns a single-text-block result verbatim when no structuredContent", async () => {
    const def = createMcpToolDefinition(
      metaOf("docs", "search"),
      fakeClient(async () => ({
        content: [{ type: "text", text: "result body" }],
      })),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("result body");
    expect(result.truncated).toBe(false);
  });

  it("does NOT truncate a ~2K JSON payload at 400 chars (regression for the GitHub-MCP looping bug)", async () => {
    // Session s-6b8f56ce-10b6-490f-94e0-b7502b384b64 reproduced this:
    // mcp.github.list_issues returned a single-line JSON array of
    // ~2-5K chars, the compressor's default 400-char cap clipped after
    // the first issue, and the model looped 8 times calling the same
    // tool with different filters trying to "find the rest". With the
    // MCP-specific cap raised to MAX_PROJECTED_OUTPUT_CHARS (8K) and
    // line-tail truncation disabled, the full payload reaches the
    // agent intact.
    const issues = Array.from({ length: 9 }, (_, i) => ({
      number: i + 1,
      title: `Issue #${i + 1}`,
      body: "x".repeat(150),
    }));
    const def = createMcpToolDefinition(
      metaOf("github", "list_issues"),
      fakeClient(async () => ({
        // Single-line JSON in the text channel (what github-mcp emits).
        content: [{ type: "text", text: JSON.stringify({ issues }) }],
      })),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(false);
    // All nine issue numbers must be present in the summary.
    for (let i = 1; i <= 9; i += 1) {
      expect(result.summary).toContain(`"number":${i}`);
    }
    expect(result.summary.length).toBeGreaterThan(400);
  });

  it("clips MCP output at MAX_PROJECTED_OUTPUT_CHARS (~8K) and sets truncated=true", async () => {
    // Beyond the 8K projector clip, structuredContent gets a
    // [truncated] suffix from clipOutput; the compressor then sees
    // the clipped string as still over its 8K char cap (equal, in
    // practice) and may or may not flip truncated again. Either way
    // the summary must stay bounded.
    const def = createMcpToolDefinition(
      metaOf("github", "search_code"),
      fakeClient(async () => ({
        structuredContent: {
          items: Array.from({ length: 500 }, (_, i) => ({
            id: i,
            body: "y".repeat(40),
          })),
        },
      })),
    );
    const result = await def.run({}, ctx);
    expect(result.status).toBe("ok");
    // Hard ceiling: 8K from the projector + at most a few chars from
    // the compressor's own clip marker.
    expect(result.summary.length).toBeLessThanOrEqual(8_100);
    expect(result.summary).toContain("[truncated]");
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
