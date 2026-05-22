import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tools/tool-registry.js";

import type { McpClient } from "./mcp-client.js";
import type { McpManager } from "./mcp-manager.js";
import {
  buildMcpPromptGetTool,
  buildMcpPromptListTool,
} from "./mcp-prompt-tools.js";
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

describe("mcp.prompt.list", () => {
  it("requires the server arg", async () => {
    const tool = buildMcpPromptListTool(makeManager({}));
    const result = await tool.run({}, ctx);
    expect(result.status).toBe("error");
    expect(result.details?.field).toBe("server");
  });

  it("renders prompts with required+optional args", async () => {
    const mgr = makeManager({
      docs: {
        catalog: {
          server: "docs",
          tools: [],
          resources: [],
          prompts: [
            {
              server: "docs",
              name: "summarize",
              description: "Summarise a doc.",
              arguments: [
                { name: "uri", required: true },
                { name: "length", required: false },
              ],
            },
          ],
        },
      },
    });
    const tool = buildMcpPromptListTool(mgr);
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("summarize(uri, length?)");
    expect(result.summary).toContain("Summarise a doc.");
  });

  it("emits a placeholder when the prompt list is empty", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
      },
    });
    const tool = buildMcpPromptListTool(mgr);
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.summary).toContain("(no prompts on docs)");
  });
});

describe("mcp.prompt.get", () => {
  it("requires server and name args", async () => {
    const tool = buildMcpPromptGetTool(makeManager({}));
    const missingServer = await tool.run({ name: "x" }, ctx);
    expect(missingServer.status).toBe("error");
    expect(missingServer.details?.field).toBe("server");

    const missingName = await tool.run({ server: "docs" }, ctx);
    expect(missingName.status).toBe("error");
    expect(missingName.details?.field).toBe("name");
  });

  it("errors when the server client is not connected", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: { isConnected: false },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    const result = await tool.run({ server: "docs", name: "x" }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("not connected");
  });

  it("renders messages as `<role>: <text>` joined by blank lines", async () => {
    let captured: { name: string; args?: Record<string, string> } | null = null;
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: {
          isConnected: true,
          getPrompt: async (name: string, args?: Record<string, string>) => {
            captured = { name, ...(args !== undefined ? { args } : {}) };
            return {
              description: "rendered",
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: "Hello." },
                },
                {
                  role: "assistant",
                  content: [
                    { type: "text", text: "Hi!" },
                    { type: "text", text: "Anything else?" },
                  ],
                },
              ],
            };
          },
        },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    const result = await tool.run(
      { server: "docs", name: "greet", arguments: { who: "world" } },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("user: Hello.");
    expect(result.summary).toContain("assistant: Hi!");
    expect(result.summary).toContain("Anything else?");
    expect(result.details?.description).toBe("rendered");
    expect(captured).toEqual({ name: "greet", args: { who: "world" } });
  });

  it("normalises non-string argument values via JSON.stringify", async () => {
    let captured: Record<string, string> | undefined;
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: {
          isConnected: true,
          getPrompt: async (_name: string, args?: Record<string, string>) => {
            captured = args;
            return { messages: [] };
          },
        },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    await tool.run(
      {
        server: "docs",
        name: "greet",
        arguments: { count: 3, flag: true, items: ["a", "b"] },
      },
      ctx,
    );
    expect(captured).toEqual({
      count: "3",
      flag: "true",
      items: '["a","b"]',
    });
  });

  it("folds transport errors into a status=error result", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: {
          isConnected: true,
          getPrompt: async () => {
            throw new Error("template not found");
          },
        },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    const result = await tool.run({ server: "docs", name: "missing" }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("template not found");
  });
});
