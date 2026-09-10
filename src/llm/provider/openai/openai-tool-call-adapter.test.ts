import { describe, it, expect } from "vitest";
import { buildMcpToolDescriptors } from "../../../mcp/mcp-descriptor-builder.js";
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
        {
          function: {
            name: "os__fs__delete",
            arguments: '{"path":"widget.txt',
          },
        },
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
      openAiToolCallsToBatch([
        { function: { name: "os__fs__delete", arguments: secret } },
      ]);
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
      (t) =>
        (t as { function: { name: string } }).function.name ===
        "os__shell__run",
    ) as { function: { parameters: Record<string, unknown> } } | undefined;
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
      (t) =>
        (t as { function: { name: string } }).function.name === "custom__tool",
    ) as { function: { parameters: Record<string, unknown> } } | undefined;
    expect(custom?.function.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("marks reply.text as required in the OpenAI tool schema", () => {
    const tools = descriptorsToOpenAiTools([]);
    const reply = tools.find(
      (tool) =>
        (tool as { function: { name: string } }).function.name === "reply",
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
  describe('strict tool schemas (supportsTools: "strict")', () => {
    const shellDescriptor = {
      name: "os.shell.run",
      tier: "frequent" as const,
      summary: "shell",
      argsSchema: "{ cmd, args, cwd? }",
      argsJsonSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["cmd", "args"],
        additionalProperties: false,
      } as Record<string, unknown>,
    };

    it("changes nothing at all when the option is absent or off", () => {
      const descriptors = [
        shellDescriptor,
        {
          name: "custom.tool",
          tier: "frequent" as const,
          summary: "no schema",
          argsSchema: "{ anything: any }",
        },
      ];
      const today = JSON.stringify(descriptorsToOpenAiTools(descriptors));
      expect(JSON.stringify(descriptorsToOpenAiTools(descriptors, {}))).toBe(
        today,
      );
      expect(
        JSON.stringify(
          descriptorsToOpenAiTools(descriptors, { strict: false }),
        ),
      ).toBe(today);
    });

    it("marks a convertible function strict and rewrites its parameters", () => {
      const tools = descriptorsToOpenAiTools([shellDescriptor], {
        strict: true,
      });
      const shell = tools.find(
        (t) =>
          (t as { function: { name: string } }).function.name ===
          "os__shell__run",
      ) as {
        function: { strict?: boolean; parameters: Record<string, unknown> };
      };
      expect(shell.function.strict).toBe(true);
      expect(shell.function.parameters).toEqual({
        type: "object",
        properties: {
          cmd: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: ["string", "null"] },
        },
        required: ["cmd", "args", "cwd"],
        additionalProperties: false,
      });
    });

    it("leaves the tools it cannot convert exactly as they ship", () => {
      const open = {
        name: "custom.tool",
        tier: "frequent" as const,
        summary: "no schema",
        argsSchema: "{ anything: any }",
      };
      const strictTools = descriptorsToOpenAiTools([open], { strict: true });
      const plainTools = descriptorsToOpenAiTools([open]);
      const pick = (
        tools: ReadonlyArray<Record<string, unknown>>,
        name: string,
      ) =>
        tools.find(
          (t) => (t as { function: { name: string } }).function.name === name,
        );
      // The open-object fallback has no strict form...
      expect(pick(strictTools, "custom__tool")).toEqual(
        pick(plainTools, "custom__tool"),
      );
      // ...and neither has `reply`, whose hand-tuned schema carries the
      // `minLength: 1` that keeps an empty final answer off the wire.
      expect(pick(strictTools, "reply")).toEqual(pick(plainTools, "reply"));
      // A mixed array is the point: `finish` converts, so it is marked.
      expect(
        (pick(strictTools, "finish") as { function: { strict?: boolean } })
          .function.strict,
      ).toBe(true);
    });

    it("survives an arbitrary MCP-supplied schema", () => {
      const metas = [
        {
          rawName: "search",
          qualifiedName: "mcp.acme.search",
          server: "acme",
          description: "search things",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2 },
              filters: { $ref: "#/$defs/Filters" },
            },
            required: ["query"],
          },
        },
        {
          rawName: "ping",
          qualifiedName: "mcp.acme.ping",
          server: "acme",
          description: "ping",
          inputSchema: { type: "object", properties: {} },
        },
        {
          rawName: "bare",
          qualifiedName: "mcp.acme.bare",
          server: "acme",
          description: "no schema at all",
        },
      ] as unknown as Parameters<typeof buildMcpToolDescriptors>[0];
      const tools = descriptorsToOpenAiTools(buildMcpToolDescriptors(metas), {
        strict: true,
      });
      const byName = new Map(
        tools.map((t) => [
          (t as { function: { name: string } }).function.name,
          t as { function: { strict?: boolean } },
        ]),
      );
      expect(byName.get("mcp__acme__search")?.function.strict).toBeUndefined();
      expect(byName.get("mcp__acme__bare")?.function.strict).toBeUndefined();
      expect(byName.get("mcp__acme__ping")?.function.strict).toBe(true);
    });

    it("drops the nulls a strict schema forces the model to send", () => {
      const call = [
        {
          function: {
            name: "memory__profile__set",
            arguments: JSON.stringify({
              key: "city",
              value: "Belgrade",
              pinned: null,
              keywords: null,
            }),
          },
        },
      ];
      // `memory.profile.set` reads `rawArgs.pinned !== undefined`, so a
      // literal null takes a branch an omitted key never would.
      expect(
        openAiToolCallsToBatch(call, undefined, { strict: true }).calls[0]
          ?.args,
      ).toEqual({ key: "city", value: "Belgrade" });
      // Off, the payload is passed through byte-for-byte as before.
      expect(openAiToolCallsToBatch(call).calls[0]?.args).toEqual({
        key: "city",
        value: "Belgrade",
        pinned: null,
        keywords: null,
      });
    });

    it("leaves nulls nested inside an argument alone", () => {
      const batch = openAiToolCallsToBatch(
        [
          {
            function: {
              name: "os__http__request",
              arguments: JSON.stringify({
                url: "https://example.test",
                body: { note: null },
              }),
            },
          },
        ],
        undefined,
        { strict: true },
      );
      expect(batch.calls[0]?.args).toEqual({
        url: "https://example.test",
        body: { note: null },
      });
    });
  });
});
