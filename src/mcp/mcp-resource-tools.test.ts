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
    const result = await tool.run(
      { server: "docs", uri: "file:///foo" },
      ctx,
    );
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
