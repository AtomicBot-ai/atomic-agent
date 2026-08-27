import { describe, it, expect } from "vitest";
import {
  nameEscape,
  nameUnescape,
  descriptorsToOpenAiTools,
  openAiToolCallsToBatch,
  ToolCallArgumentsParseError,
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

  it("maps a legitimately empty arguments string to {}", () => {
    const batch = openAiToolCallsToBatch([
      { function: { name: "os__fs__list", arguments: "" } },
    ]);
    expect(batch.calls[0]?.args).toEqual({});
    const whitespaceOnly = openAiToolCallsToBatch([
      { function: { name: "os__fs__list", arguments: "   " } },
    ]);
    expect(whitespaceOnly.calls[0]?.args).toEqual({});
  });

  it("throws ToolCallArgumentsParseError on malformed non-empty JSON instead of substituting {}", () => {
    expect(() =>
      openAiToolCallsToBatch([
        { function: { name: "os__fs__delete", arguments: '{"path":"widget.txt' } },
      ]),
    ).toThrow(ToolCallArgumentsParseError);
  });

  it("throws on container-level truncated JSON instead of substituting {}", () => {
    expect(() =>
      openAiToolCallsToBatch([
        {
          function: {
            name: "os__shell__run",
            arguments: '{"commands":["npm install","npm test"',
          },
        },
      ]),
    ).toThrow(ToolCallArgumentsParseError);
  });

  it("throws when arguments parse to valid JSON that is not an object (array/primitive)", () => {
    expect(() =>
      openAiToolCallsToBatch([
        { function: { name: "os__fs__delete", arguments: "[1,2,3]" } },
      ]),
    ).toThrow(ToolCallArgumentsParseError);
    expect(() =>
      openAiToolCallsToBatch([
        { function: { name: "os__fs__delete", arguments: "5" } },
      ]),
    ).toThrow(ToolCallArgumentsParseError);
  });

  it("never includes the raw arguments string in the thrown error's message", () => {
    const secret = '{"path":"/etc/shadow","token":"sk-super-secret-do-not-log';
    try {
      openAiToolCallsToBatch([{ function: { name: "os__fs__delete", arguments: secret } }]);
      expect.unreachable("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallArgumentsParseError);
      expect((err as Error).message).not.toContain("sk-super-secret");
      expect((err as Error).message).not.toContain("/etc/shadow");
    }
  });

  it("valid object args still parse normally (control)", () => {
    const batch = openAiToolCallsToBatch([
      { function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' } },
    ]);
    expect(batch.calls[0]?.args).toEqual({ path: "a.txt" });
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
