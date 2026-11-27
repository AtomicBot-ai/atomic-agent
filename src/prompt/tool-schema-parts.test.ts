import { describe, expect, it } from "vitest";

import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import type { ToolDescriptor } from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";
import {
  NO_TOOL_SCHEMA,
  measureToolSchema,
  toolSchemaPromptInput,
} from "./tool-schema-parts.js";

const READ: ToolDescriptor = { name: "os.fs.read", summary: "Read a file.", argsSchema: "{ path: string }" };

function mcpTool(server: string, name: string, words = 4): ToolDescriptor {
  return {
    name: `mcp.${server}.${name}`,
    summary: `[mcp:${server}] ${name}`,
    argsSchema: `{ ${Array.from({ length: words }, (_, i) => `field${i}: string`).join(", ")} }`,
  };
}

const sum = (xs: readonly { tokens: number }[] | undefined): number =>
  (xs ?? []).reduce((a, x) => a + x.tokens, 0);

describe("measureToolSchema (ATO-2453)", () => {
  it("keeps the total the request was always budgeted at", () => {
    const descriptors = [READ, mcpTool("github", "create_issue")];
    const measure = measureToolSchema(openAiToolCallAdapter, descriptors, { strict: false });
    const wire = openAiToolCallAdapter.descriptorsToTools(descriptors, { strict: false });
    expect(measure.tokens).toBe(estimateTokens(JSON.stringify(wire)));
  });

  it("splits the array by MCP server, each server by tool", () => {
    const descriptors = [
      READ,
      mcpTool("github", "create_issue", 40),
      mcpTool("github", "list_prs", 2),
      mcpTool("slack", "post"),
    ];
    const measure = measureToolSchema(openAiToolCallAdapter, descriptors, { strict: false });
    expect(measure.parts.map((p) => p.label)).toEqual(["built-in tools", "mcp github", "mcp slack"]);
    expect(sum(measure.parts)).toBe(measure.tokens);
    const github = measure.parts.find((p) => p.mcpServer === "github")!;
    expect(github.tools?.map((t) => t.label)).toEqual(["create_issue", "list_prs"]);
    expect(sum(github.tools)).toBe(github.tokens);
  });

  it("has no split without an MCP tool on the wire", () => {
    const measure = measureToolSchema(openAiToolCallAdapter, [READ], { strict: false });
    expect(measure.parts).toEqual([]);
    expect(toolSchemaPromptInput(measure)).toEqual({ toolSchemaTokens: measure.tokens });
  });

  it("passes the split with its total", () => {
    const measure = measureToolSchema(openAiToolCallAdapter, [READ, mcpTool("x", "y")], { strict: false });
    expect(toolSchemaPromptInput(measure)).toEqual({
      toolSchemaTokens: measure.tokens,
      toolSchemaParts: measure.parts,
    });
    expect(toolSchemaPromptInput(NO_TOOL_SCHEMA)).toEqual({ toolSchemaTokens: NO_TOOL_SCHEMA.tokens });
  });
});
