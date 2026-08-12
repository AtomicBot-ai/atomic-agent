import { describe, expect, it } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import { adaptQwenTaggedToolResponse } from "./qwen-tagged-tool-response-adapter.js";

const offeredTools: NonNullable<CompletionRequest["tools"]> = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          count: { type: "integer" },
          ratio: { type: "number" },
          enabled: { type: "boolean" },
          paths: { type: "array", items: { type: "string" } },
          options: { type: "object" },
          nothing: { type: "null" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
];

function responseWith(message: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "qwen",
    choices: [{ message, finish_reason: "stop" }],
  };
}

function firstMessage(response: Record<string, unknown>): Record<string, unknown> {
  const choices = response.choices as Array<Record<string, unknown>>;
  return choices[0]!.message as Record<string, unknown>;
}

describe("adaptQwenTaggedToolResponse", () => {
  it("converts ordered dotted and escaped calls to the exact offered wire name", () => {
    const tagged = [
      "<tool_call><function=os.fs.read>",
      "<parameter=text> hello </parameter>",
      "<parameter=count>42</parameter>",
      "<parameter=ratio>3.5</parameter>",
      "<parameter=enabled>true</parameter>",
      '<parameter=paths>["a","b"]</parameter>',
      '<parameter=options>{"recursive":false}</parameter>',
      "<parameter=nothing>null</parameter>",
      "</function></tool_call>",
      "<tool_call><function=os__fs__read>",
      "<parameter=text>second</parameter>",
      "</function></tool_call>",
    ].join("");

    const adapted = adaptQwenTaggedToolResponse(
      responseWith({ role: "assistant", content: tagged }),
      { prompt: "read", tools: offeredTools },
    );
    const message = firstMessage(adapted);
    const calls = message.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;

    expect(message.content).toBeNull();
    expect(calls.map((call) => call.function.name)).toEqual([
      "os__fs__read",
      "os__fs__read",
    ]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      text: "hello",
      count: 42,
      ratio: 3.5,
      enabled: true,
      paths: ["a", "b"],
      options: { recursive: false },
      nothing: null,
    });
    expect(JSON.parse(calls[1]!.function.arguments)).toEqual({ text: "second" });
  });

  it("converts a tagged call from reasoning_content", () => {
    const adapted = adaptQwenTaggedToolResponse(
      responseWith({
        role: "assistant",
        content: "brief rationale",
        reasoning_content:
          "<tool_call><function=reply><parameter=text>done</parameter></function></tool_call>",
      }),
      { prompt: "answer", tools: offeredTools },
    );
    const message = firstMessage(adapted);

    expect(message.content).toBe("brief rationale");
    expect(message.reasoning_content).toBeNull();
    expect(message.tool_calls).toMatchObject([
      { type: "function", function: { name: "reply", arguments: '{"text":"done"}' } },
    ]);
  });

  it("rejects the entire tagged response when any call is invalid", () => {
    const inputs = [
      [
        "<tool_call><function=os.fs.read><parameter=count>four</parameter></function></tool_call>",
        "<tool_call><function=reply><parameter=text>must-not-run</parameter></function></tool_call>",
      ].join(""),
      [
        "<tool_call><function=not.offered><parameter=x>1</parameter></function></tool_call>",
        "<tool_call><function=reply><parameter=text>must-not-run</parameter></function></tool_call>",
      ].join(""),
    ];

    for (const content of inputs) {
      const original = responseWith({ role: "assistant", content });
      const adapted = adaptQwenTaggedToolResponse(original, {
        tools: offeredTools,
      });

      expect(adapted).toBe(original);
      expect(firstMessage(adapted).tool_calls).toBeUndefined();
    }
  });

  it("rejects undeclared, duplicate, and missing required parameters", () => {
    const inputs = [
      "<tool_call><function=reply><parameter=text>ok</parameter><parameter=extra>no</parameter></function></tool_call>",
      "<tool_call><function=reply><parameter=text>one</parameter><parameter=text>two</parameter></function></tool_call>",
      "<tool_call><function=reply></function></tool_call>",
    ];

    for (const content of inputs) {
      const original = responseWith({ role: "assistant", content });
      expect(
        adaptQwenTaggedToolResponse(original, { tools: offeredTools }),
      ).toBe(original);
    }
  });

  it("does not convert absent, unknown, malformed, or prose-mixed tags", () => {
    const inputs = [
      "ordinary assistant prose",
      "<tool_call><function=not.offered><parameter=x>1</parameter></function></tool_call>",
      "<tool_call><function=reply><parameter=text>missing close</function></tool_call>",
      "Here is an example: <tool_call><function=reply><parameter=text>no</parameter></function></tool_call>",
    ];

    for (const content of inputs) {
      const original = responseWith({ role: "assistant", content });
      const adapted = adaptQwenTaggedToolResponse(original, {
        prompt: "x",
        tools: offeredTools,
      });
      expect(adapted).toBe(original);
      expect(firstMessage(adapted).tool_calls).toBeUndefined();
    }
  });

  it("leaves non-empty native tool_calls unchanged and preferred", () => {
    const native = [
      {
        id: "native-1",
        type: "function",
        function: { name: "reply", arguments: '{"text":"native"}' },
      },
    ];
    const original = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=reply><parameter=text>tagged</parameter></function></tool_call>",
      tool_calls: native,
    });

    const adapted = adaptQwenTaggedToolResponse(original, {
      prompt: "x",
      tools: offeredTools,
    });

    expect(adapted).toBe(original);
    expect(firstMessage(adapted).tool_calls).toBe(native);
  });

  it("treats an empty native tool_calls array as absent", () => {
    const adapted = adaptQwenTaggedToolResponse(
      responseWith({
        role: "assistant",
        content:
          "<tool_call><function=reply><parameter=text>tagged</parameter></function></tool_call>",
        tool_calls: [],
      }),
      { prompt: "x", tools: offeredTools },
    );

    expect(firstMessage(adapted).tool_calls).toMatchObject([
      { function: { name: "reply", arguments: '{"text":"tagged"}' } },
    ]);
  });

  it("accepts only the literal null token for null parameters", () => {
    const original = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=os.fs.read><parameter=nothing>not-null</parameter></function></tool_call>",
    });

    expect(
      adaptQwenTaggedToolResponse(original, { prompt: "x", tools: offeredTools }),
    ).toBe(original);
  });

  it("rejects values that violate offered nested, enum, and union schemas", () => {
    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "constrained",
          parameters: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["safe"] },
              limit: {
                anyOf: [{ type: "integer" }, { type: "null" }],
                maximum: 10,
              },
              options: {
                type: "object",
                properties: { recursive: { type: "boolean" } },
                required: ["recursive"],
                additionalProperties: false,
              },
            },
            required: ["paths", "mode", "limit", "options"],
          },
        },
      },
    ];
    const invalidValues = [
      ["paths", '["a",2]'],
      ["mode", "unsafe"],
      ["limit", "1.5"],
      ["limit", "20"],
      ["options", '{"recursive":"false"}'],
      ["options", '{"recursive":false,"extra":true}'],
    ] as const;

    for (const [invalidName, invalidValue] of invalidValues) {
      const values = {
        paths: '["a","b"]',
        mode: "safe",
        limit: "2",
        options: '{"recursive":false}',
        [invalidName]: invalidValue,
      };
      const parameters = Object.entries(values)
        .map(([name, value]) => `<parameter=${name}>${value}</parameter>`)
        .join("");
      const original = responseWith({
        role: "assistant",
        content: `<tool_call><function=constrained>${parameters}</function></tool_call>`,
      });

      expect(adaptQwenTaggedToolResponse(original, { tools })).toBe(original);
    }
  });

  it("accepts a payload that satisfies nested, enum, and union schemas", () => {
    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "constrained",
          parameters: {
            type: "object",
            properties: {
              paths: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["safe"] },
              limit: {
                anyOf: [{ type: "integer" }, { type: "null" }],
                maximum: 10,
              },
              options: {
                type: "object",
                properties: { recursive: { type: "boolean" } },
                required: ["recursive"],
                additionalProperties: false,
              },
            },
            required: ["paths", "mode", "limit", "options"],
          },
        },
      },
    ];
    const adapted = adaptQwenTaggedToolResponse(
      responseWith({
        role: "assistant",
        content:
          '<tool_call><function=constrained><parameter=paths>["a","b"]</parameter><parameter=mode>safe</parameter><parameter=limit>2</parameter><parameter=options>{"recursive":false}</parameter></function></tool_call>',
      }),
      { tools },
    );
    const calls = firstMessage(adapted).tool_calls as Array<{
      function: { arguments: string };
    }>;

    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      paths: ["a", "b"],
      mode: "safe",
      limit: 2,
      options: { recursive: false },
    });
  });

  it("validates root combinators before emitting executable arguments", () => {
    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "root-constrained",
          parameters: {
            type: "object",
            properties: {
              left: { type: "string" },
              right: { type: "string" },
            },
            oneOf: [{ required: ["left"] }, { required: ["right"] }],
            additionalProperties: false,
          },
        },
      },
    ];
    const missing = responseWith({
      role: "assistant",
      content: "<tool_call><function=root-constrained></function></tool_call>",
    });
    const both = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=root-constrained><parameter=left>a</parameter><parameter=right>b</parameter></function></tool_call>",
    });
    const valid = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=root-constrained><parameter=left>a</parameter></function></tool_call>",
    });

    expect(adaptQwenTaggedToolResponse(missing, { tools })).toBe(missing);
    expect(adaptQwenTaggedToolResponse(both, { tools })).toBe(both);
    expect(firstMessage(adaptQwenTaggedToolResponse(valid, { tools })).tool_calls).toBeDefined();
  });

  it("inherits parent types while coercing oneOf alternatives", () => {
    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "typed-union",
          parameters: {
            type: "object",
            properties: {
              value: {
                type: "integer",
                oneOf: [{ maximum: 10 }, { minimum: 20 }],
              },
            },
            required: ["value"],
          },
        },
      },
    ];
    const valid = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=typed-union><parameter=value>5</parameter></function></tool_call>",
    });
    const invalid = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=typed-union><parameter=value>15</parameter></function></tool_call>",
    });

    const adapted = adaptQwenTaggedToolResponse(valid, { tools });
    const calls = firstMessage(adapted).tool_calls as Array<{
      function: { arguments: string };
    }>;
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ value: 5 });
    expect(adaptQwenTaggedToolResponse(invalid, { tools })).toBe(invalid);
  });

  it("enforces common assertions and fails closed on unsupported schemas", () => {
    const assertedTools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "asserted",
          parameters: {
            type: "object",
            properties: {
              even: { type: "integer", multipleOf: 2 },
              tags: { type: "array", items: { type: "string" }, uniqueItems: true },
              mode: { type: "string", not: { const: "blocked" } },
            },
            required: ["even", "tags", "mode"],
          },
        },
      },
    ];
    const invalidParameters = [
      '<parameter=even>3</parameter><parameter=tags>["a"]</parameter><parameter=mode>safe</parameter>',
      '<parameter=even>4</parameter><parameter=tags>["a","a"]</parameter><parameter=mode>safe</parameter>',
      '<parameter=even>4</parameter><parameter=tags>["a"]</parameter><parameter=mode>blocked</parameter>',
    ];
    for (const parameters of invalidParameters) {
      const original = responseWith({
        role: "assistant",
        content: `<tool_call><function=asserted>${parameters}</function></tool_call>`,
      });
      expect(adaptQwenTaggedToolResponse(original, { tools: assertedTools })).toBe(
        original,
      );
    }

    const unsupportedTools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "unsupported",
          parameters: {
            type: "object",
            properties: { value: { $ref: "#/$defs/value" } },
            required: ["value"],
            $defs: { value: { type: "string" } },
          },
        },
      },
    ];
    const unsupported = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=unsupported><parameter=value>x</parameter></function></tool_call>",
    });
    expect(adaptQwenTaggedToolResponse(unsupported, { tools: unsupportedTools })).toBe(
      unsupported,
    );
  });

  it("uses own-property checks for prototype-named parameters", () => {
    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        type: "function",
        function: {
          name: "prototype-safe",
          parameters: {
            type: "object",
            properties: { constructor: { type: "string" } },
            required: ["constructor"],
          },
        },
      },
    ];
    const missing = responseWith({
      role: "assistant",
      content: "<tool_call><function=prototype-safe></function></tool_call>",
    });
    const supplied = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=prototype-safe><parameter=constructor>own</parameter></function></tool_call>",
    });
    const unofferedPrototype = responseWith({
      role: "assistant",
      content:
        "<tool_call><function=prototype-safe><parameter=__proto__>no</parameter><parameter=constructor>own</parameter></function></tool_call>",
    });

    expect(adaptQwenTaggedToolResponse(missing, { tools })).toBe(missing);
    expect(adaptQwenTaggedToolResponse(unofferedPrototype, { tools })).toBe(
      unofferedPrototype,
    );
    const adapted = adaptQwenTaggedToolResponse(supplied, { tools });
    const calls = firstMessage(adapted).tool_calls as Array<{
      function: { arguments: string };
    }>;
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ constructor: "own" });
  });
});
