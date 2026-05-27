import { describe, it, expect } from "vitest";
import {
  nameEscape,
  nameUnescape,
  descriptorsToOpenAiTools,
  openAiToolCallsToBatch,
} from "./openai-tool-call-adapter.js";

describe("OpenAiToolCallAdapter", () => {
  it("round-trips dotted tool names via __ escape", () => {
    expect(nameEscape("os.fs.read")).toBe("os__fs__read");
    expect(nameUnescape("os__fs__read")).toBe("os.fs.read");
    expect(nameEscape("mcp.github.search_issues")).toBe(
      "mcp__github__search_issues",
    );
    expect(nameUnescape("mcp__github__search_issues")).toBe(
      "mcp.github.search_issues",
    );
  });

  it("maps tool_calls to ToolCallBatch", () => {
    const batch = openAiToolCallsToBatch([
      {
        function: {
          name: "reply",
          arguments: JSON.stringify({ text: "hello" }),
        },
      },
    ]);
    expect(batch.calls).toHaveLength(1);
    expect(batch.calls[0]?.tool).toBe("reply");
    expect(batch.calls[0]?.args).toMatchObject({ text: "hello" });
  });

  it("includes reply and finish in descriptorsToOpenAiTools", () => {
    const tools = descriptorsToOpenAiTools([
      {
        name: "os.fs.read",
        tier: "frequent",
        summary: "read file",
        argsSchema: "path: string",
      },
    ]);
    const names = tools.map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toContain("os__fs__read");
    expect(names).toContain("reply");
    expect(names).toContain("finish");
  });

  it("propagates argsJsonSchema verbatim into function.parameters when present", () => {
    const schema = {
      type: "object",
      properties: {
        cmd: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["cmd", "args"],
      additionalProperties: false,
    } as const;
    const tools = descriptorsToOpenAiTools([
      {
        name: "os.shell.run",
        tier: "frequent",
        summary: "shell",
        argsSchema: "{ cmd, args }",
        argsJsonSchema: schema as Record<string, unknown>,
      },
    ]);
    const shell = tools.find(
      (t) => (t as { function: { name: string } }).function.name === "os__shell__run",
    ) as
      | { function: { parameters: Record<string, unknown> } }
      | undefined;
    expect(shell?.function.parameters).toEqual(schema);
  });

  it("falls back to an open object schema when argsJsonSchema is absent", () => {
    const tools = descriptorsToOpenAiTools([
      {
        name: "custom.tool",
        tier: "frequent",
        summary: "no schema",
        argsSchema: "{ anything: any }",
      },
    ]);
    const custom = tools.find(
      (t) => (t as { function: { name: string } }).function.name === "custom__tool",
    ) as
      | { function: { parameters: Record<string, unknown> } }
      | undefined;
    expect(custom?.function.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("marks reply.text as required in the OpenAI tool schema", () => {
    const tools = descriptorsToOpenAiTools([]);
    const reply = tools.find(
      (tool) => (tool as { function: { name: string } }).function.name === "reply",
    ) as
      | {
          function: {
            description: string;
            parameters: {
              properties: Record<string, unknown>;
              required?: string[];
            };
          };
        }
      | undefined;

    expect(reply?.function.description).toContain("Args: text: string");
    expect(reply?.function.parameters.required).toEqual(["text"]);
    expect(reply?.function.parameters.properties).toHaveProperty("text");
  });
});
