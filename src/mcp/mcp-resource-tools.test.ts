import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import type { McpManager } from "./mcp-manager.js";
import {
  buildMcpResourceListTool,
  buildMcpResourceReadTool,
} from "./mcp-resource-tools.js";
import type { McpServerCatalog } from "./mcp-types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "s-test",
  stepIndex: 0,
  signal: new AbortController().signal,
};

interface FakeServer {
  catalog: McpServerCatalog;
  client?: Partial<McpClient> & { isConnected: boolean };
}

function makeManager(servers: Record<string, FakeServer>): McpManager {
  const fake = {
    getCatalog: (name: string) => servers[name]?.catalog,
    getClient: (name: string) => servers[name]?.client as McpClient | undefined,
  };
  return fake as unknown as McpManager;
}

describe("mcp.resource.list", () => {
  it("requires the server arg", async () => {
    const tool = buildMcpResourceListTool(makeManager({}));
    const result = await tool.run({}, ctx);
    expect(result.status).toBe("error");
    expect(result.details?.field).toBe("server");
  });

  it("errors on unknown server", async () => {
    const tool = buildMcpResourceListTool(makeManager({}));
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("unknown server");
  });

  it("formats each resource as `<uri> [mime] name — description`", async () => {
    const mgr = makeManager({
      docs: {
        catalog: {
          server: "docs",
          tools: [],
          prompts: [],
          resources: [
            {
              server: "docs",
              uri: "file:///foo.md",
              name: "Foo",
              description: "first doc",
              mimeType: "text/markdown",
            },
          ],
        },
      },
    });
    const tool = buildMcpResourceListTool(mgr);
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("file:///foo.md");
    expect(result.summary).toContain("[text/markdown]");
    expect(result.summary).toContain("Foo");
    expect(result.summary).toContain("first doc");
  });

  it("clamps limit to 100 and falls back to default when invalid", async () => {
    const resources = Array.from({ length: 150 }, (_, i) => ({
      server: "docs",
      uri: `file:///r${i}`,
    }));
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources },
      },
    });
    const tool = buildMcpResourceListTool(mgr);
    const clamped = await tool.run({ server: "docs", limit: 99999 }, ctx);
    expect(clamped.details?.count).toBe(100);
    expect(clamped.details?.total).toBe(150);

    const def = await tool.run({ server: "docs", limit: "bogus" }, ctx);
    expect(def.details?.count).toBe(30);
  });

  // The listing is an ordered catalog and carries no header line, so
  // its first rows ARE its header: the index / README / entry-point
  // resources a server lists first. The compressor defaults kept the
  // LAST 12 rows of up to 100 and sliced them to 385 chars, which is
  // backwards for a catalog — and the tool takes no offset argument,
  // so the dropped rows were unreachable.
  it("keeps the first rows of a 100-resource catalog", async () => {
    const resources = Array.from({ length: 100 }, (_, i) => ({
      server: "docs",
      uri: `file:///r${i}.md`,
      name: `Doc ${i}`,
      description: `resource number ${i} in catalog order`,
      mimeType: "text/markdown",
    }));
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources },
      },
    });
    const tool = buildMcpResourceListTool(mgr);
    const result = await tool.run({ server: "docs", limit: 100 }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("file:///r0.md");
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain("file:///r1.md");
    expect(result.summary).toContain("file:///r50.md");
    expect(result.summary).toContain("file:///r99.md");
    expect(result.summary).not.toContain("[omitted");
    expect(result.summary.split("\n")).toHaveLength(100);
    expect(result.summary.length).toBeGreaterThan(400);
    // `details` already reported 100; the summary must agree.
    expect(result.details?.count).toBe(100);
  });

  // Over the derived budget the one remaining cut is head-anchored,
  // so the rows the model keeps are still the first ones.
  it("cuts an over-budget catalog from the end, not the start", async () => {
    const resources = Array.from({ length: 100 }, (_, i) => ({
      server: "docs",
      uri: `file:///r${i}.md`,
      description: "d".repeat(400),
    }));
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources },
      },
    });
    const tool = buildMcpResourceListTool(mgr);
    const result = await tool.run({ server: "docs", limit: 100 }, ctx);
    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.summary.startsWith("file:///r0.md")).toBe(true);
    expect(result.summary).not.toContain("file:///r99.md");
    expect(result.summary.length).toBeGreaterThan(20_000);
    expect(result.summary).toContain("… [truncated]");
  });

  it("emits a placeholder line when the resource list is empty", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
      },
    });
    const tool = buildMcpResourceListTool(mgr);
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.summary).toContain("(no resources on docs)");
  });
});

describe("mcp.resource.read", () => {
  it("requires server and uri args", async () => {
    const tool = buildMcpResourceReadTool(makeManager({}));
    const missingServer = await tool.run({ uri: "file:///foo" }, ctx);
    expect(missingServer.status).toBe("error");
    expect(missingServer.details?.field).toBe("server");

    const missingUri = await tool.run({ server: "docs" }, ctx);
    expect(missingUri.status).toBe("error");
    expect(missingUri.details?.field).toBe("uri");
  });

  it("errors when the server client is not connected", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
        client: { isConnected: false },
      },
    });
    const tool = buildMcpResourceReadTool(mgr);
    const result = await tool.run({ server: "docs", uri: "file:///foo" }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("not connected");
  });

  it("concatenates text contents from the server response", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
        client: {
          isConnected: true,
          readResource: async () => ({
            contents: [
              { text: "first chunk" },
              { text: "second chunk" },
              { blob: "AAAA", mimeType: "image/png" },
            ],
          }),
        },
      },
    });
    const tool = buildMcpResourceReadTool(mgr);
    const result = await tool.run(
      { server: "docs", uri: "file:///foo.md" },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("first chunk");
    expect(result.summary).toContain("second chunk");
    expect(result.summary).toContain("[blob image/png");
  });

  // `projectResourceContents` budgets the payload at 16_000 chars;
  // the compressor defaults used to throw that budget away, keeping
  // the last 12 non-blank lines and then slicing them to 385 chars.
  // A resource is a document: its opening must survive.
  it("keeps the whole projected document, opening first", async () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line-${i}: ${"x".repeat(40)}`,
    );
    const body = lines.join("\n");
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
        client: {
          isConnected: true,
          readResource: async () => ({ contents: [{ text: body }] }),
        },
      },
    });
    const tool = buildMcpResourceReadTool(mgr);
    const result = await tool.run(
      { server: "docs", uri: "file:///big.md" },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("line-0:");
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain("line-100:");
    expect(result.summary).toContain("line-199:");
    expect(result.summary).not.toContain("[truncated]");
    expect(result.summary.length).toBeGreaterThan(400);
    expect(result.summary).toBe(body);
  });

  // The projector's own 16_000-char clip stays the only cut, and it
  // is head-anchored, so the opening is still what the model reads.
  it("clips at the projector budget, not at the 400-char default", async () => {
    const body = "A".repeat(20_000);
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
        client: {
          isConnected: true,
          readResource: async () => ({ contents: [{ text: body }] }),
        },
      },
    });
    const tool = buildMcpResourceReadTool(mgr);
    const result = await tool.run(
      { server: "docs", uri: "file:///huge.md" },
      ctx,
    );
    expect(result.status).toBe("ok");
    // 16_000 - 14 chars of body + the projector's own marker.
    expect(result.summary.length).toBeGreaterThan(15_000);
    expect(result.summary.length).toBeLessThanOrEqual(16_000);
    expect(result.summary.endsWith("…[truncated]")).toBe(true);
  });

  it("folds transport errors into a status=error result", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], prompts: [], resources: [] },
        client: {
          isConnected: true,
          readResource: async () => {
            throw new Error("404 not found");
          },
        },
      },
    });
    const tool = buildMcpResourceReadTool(mgr);
    const result = await tool.run(
      { server: "docs", uri: "file:///missing" },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("404 not found");
  });
});
