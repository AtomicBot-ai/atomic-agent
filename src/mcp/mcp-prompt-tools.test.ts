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

  // This listing is the catalog the model picks a `mcp.prompt.get`
  // name from, and it carries no header line — its first rows are
  // what a server leads with. The compressor defaults kept the LAST
  // 12 of up to 100 rows and sliced them to 385 chars, so a template
  // the model never saw was a template it could not call.
  it("keeps the first rows of a 100-prompt catalog", async () => {
    const prompts = Array.from({ length: 100 }, (_, i) => ({
      server: "docs",
      name: `prompt_${i}`,
      description: `catalog order ${i}`,
      arguments: [
        { name: "uri", required: true },
        { name: "length", required: false },
      ],
    }));
    const mgr = makeManager({
      docs: { catalog: { server: "docs", tools: [], resources: [], prompts } },
    });
    const tool = buildMcpPromptListTool(mgr);
    const result = await tool.run({ server: "docs", limit: 100 }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("prompt_0(uri, length?)");
    expect(result.summary).toContain("prompt_1(uri, length?)");
    expect(result.summary).toContain("prompt_50(uri, length?)");
    expect(result.summary).toContain("prompt_99(uri, length?)");
    expect(result.summary).not.toContain("[omitted");
    expect(result.summary.split("\n")).toHaveLength(100);
    expect(result.summary.length).toBeGreaterThan(400);
    expect(result.details?.count).toBe(100);
  });

  // Same untrusted-input clamp as the resource listing: one greedy
  // template must not be able to hide the other 99 from the model.
  it("clamps a verbose row so it cannot crowd out the catalog", async () => {
    const prompts = Array.from({ length: 100 }, (_, i) => ({
      server: "docs",
      name: `prompt_${i}`,
      description: i === 0 ? "D".repeat(7_900) : `catalog order ${i}`,
      arguments: [{ name: "uri", required: true }],
    }));
    const mgr = makeManager({
      docs: { catalog: { server: "docs", tools: [], resources: [], prompts } },
    });
    const tool = buildMcpPromptListTool(mgr);
    const result = await tool.run({ server: "docs", limit: 100 }, ctx);
    expect(result.status).toBe("ok");
    const rows = result.summary.split("\n");
    expect(rows[0]).toContain("prompt_0(uri)");
    expect(rows[0]!.length).toBeLessThanOrEqual(365);
    expect(rows).toHaveLength(100);
    expect(result.summary).toContain("prompt_99(uri)");
  });

  it("flattens control characters in a catalog field", async () => {
    const mgr = makeManager({
      docs: {
        catalog: {
          server: "docs",
          tools: [],
          resources: [],
          prompts: [
            {
              server: "docs",
              name: "greet",
              description: "first line\nsecond line",
              arguments: [{ name: "who", required: true }],
            },
            { server: "docs", name: "other" },
          ],
        },
      },
    });
    const tool = buildMcpPromptListTool(mgr);
    const result = await tool.run({ server: "docs" }, ctx);
    expect(result.summary.split("\n")).toHaveLength(2);
    expect(result.summary).toContain("first line second line");
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

  // `projectPromptMessages` budgets the rendered template at 8_000
  // chars; the compressor defaults used to throw that budget away,
  // keeping the last 12 non-blank lines and slicing them to 385
  // chars. The `system:` opening carries the instructions, so it is
  // exactly the part that must not be dropped.
  it("keeps the whole rendered template, opening first", async () => {
    const systemText = [
      "You are a release auditor.",
      ...Array.from({ length: 60 }, (_, i) => `rule ${i}: ${"y".repeat(40)}`),
    ].join("\n");
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: {
          isConnected: true,
          getPrompt: async () => ({
            messages: [
              { role: "system", content: { type: "text", text: systemText } },
              { role: "user", content: { type: "text", text: "Go." } },
            ],
          }),
        },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    const result = await tool.run({ server: "docs", name: "audit" }, ctx);
    expect(result.status).toBe("ok");
    const summary = result.summary;
    expect(summary.startsWith("system: You are a release auditor.")).toBe(true);
    expect(result.summary).toContain("rule 0:");
    expect(result.summary).toContain("rule 59:");
    expect(result.summary).toContain("user: Go.");
    expect(result.summary).not.toContain("[truncated]");
    expect(result.summary.length).toBeGreaterThan(400);
    // `projectPromptMessages` joins messages with a BLANK line, which
    // `extractTail` then drops (result-compressor.ts). Every line of
    // text survives in order; the separator between the messages does
    // not, so this is not the projected string byte-for-byte.
    expect(result.summary).not.toContain("\n\n");
  });

  it("clips at the deliverable budget, not at the 400-char default", async () => {
    const mgr = makeManager({
      docs: {
        catalog: { server: "docs", tools: [], resources: [], prompts: [] },
        client: {
          isConnected: true,
          getPrompt: async () => ({
            messages: [
              {
                role: "user",
                content: { type: "text", text: "B".repeat(12_000) },
              },
            ],
          }),
        },
      },
    });
    const tool = buildMcpPromptGetTool(mgr);
    const result = await tool.run({ server: "docs", name: "big" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary.startsWith("user: BBB")).toBe(true);
    expect(result.summary.length).toBeGreaterThan(7_000);
    expect(result.summary.length).toBeLessThanOrEqual(8_000);
    expect(result.summary.endsWith("…[truncated]")).toBe(true);
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
