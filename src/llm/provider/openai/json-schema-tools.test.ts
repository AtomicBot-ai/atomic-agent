import { describe, expect, it } from "vitest";

import type { CompletionRequest, CompletionResult } from "../completion-types.js";
import {
  applyJsonSchemaToolReply,
  buildJsonSchemaToolFormat,
  JSON_SCHEMA_TOOLS_FORMAT_NAME,
  parseJsonSchemaToolReply,
  toJsonSchemaToolRequest,
} from "./json-schema-tools.js";

const READ_PARAMS = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      description: "Read a file.",
      parameters: READ_PARAMS,
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

function itemsOf(schema: Record<string, unknown>): Record<string, unknown>[] {
  const calls = (schema.properties as Record<string, Record<string, unknown>>)
    .calls!;
  return (calls.items as { anyOf: Record<string, unknown>[] }).anyOf;
}

function result(content: string, extra: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "m",
    finishReason: "stop",
    ...extra,
  };
}

describe("buildJsonSchemaToolFormat", () => {
  it("has one anyOf branch per tool, holding arguments to the tool's own schema", () => {
    const format = buildJsonSchemaToolFormat(TOOLS, { allowAnswer: true });
    expect(format.name).toBe(JSON_SCHEMA_TOOLS_FORMAT_NAME);
    expect(format.schema).toMatchObject({
      type: "object",
      required: ["calls"],
      additionalProperties: false,
    });
    const branches = itemsOf(format.schema);
    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({
      type: "object",
      description: "Read a file.",
      properties: {
        name: { type: "string", enum: ["os__fs__read"] },
        arguments: READ_PARAMS,
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    });
    expect(branches[2]).toMatchObject({
      properties: { answer: { type: "string", minLength: 1 } },
      required: ["answer"],
    });
  });

  it("drops the answer branch when a call is required, and caps the batch when asked", () => {
    const format = buildJsonSchemaToolFormat(TOOLS, {
      allowAnswer: false,
      maxCalls: 1,
    });
    const branches = itemsOf(format.schema);
    expect(branches).toHaveLength(2);
    expect(branches.some((b) => "answer" in (b.properties as object))).toBe(false);
    const calls = (format.schema.properties as Record<string, Record<string, unknown>>)
      .calls!;
    expect(calls).toMatchObject({ minItems: 1, maxItems: 1 });
  });

  it("gives a tool without parameters an empty object schema", () => {
    const format = buildJsonSchemaToolFormat(
      [{ type: "function", function: { name: "tool__list" } }],
      { allowAnswer: false },
    );
    expect(itemsOf(format.schema)[0]).toMatchObject({
      properties: { arguments: { type: "object", properties: {} } },
    });
  });
});

describe("toJsonSchemaToolRequest", () => {
  const base: CompletionRequest = {
    prompt: "### respond\nRespond now.",
    tools: TOOLS,
    toolChoice: "auto",
    parallelToolCalls: true,
    messages: { system: "s", droppedSummary: null, turns: [], tail: "t" },
    sessionId: "s1",
  };

  it("sends no tools and no native messages, a schema, and the reply-format note", () => {
    const plan = toJsonSchemaToolRequest(base)!;
    const wire = plan.wireRequest;
    expect(wire.tools).toBeUndefined();
    expect(wire.toolChoice).toBeUndefined();
    expect(wire.parallelToolCalls).toBeUndefined();
    expect(wire.messages).toBeUndefined();
    expect(wire.sessionId).toBe("s1");
    expect(wire.responseFormat?.name).toBe(JSON_SCHEMA_TOOLS_FORMAT_NAME);
    expect(wire.prompt.startsWith("### respond\nRespond now.\n\n### reply-format\n")).toBe(true);
    expect(wire.prompt).toContain("Tools: os__fs__read, reply.");
    expect(wire.prompt).toContain('{"answer"');
    expect([...plan.offeredNames]).toEqual(["os__fs__read", "reply"]);
    // The caller's request is left alone.
    expect(base.tools).toBe(TOOLS);
  });

  it("is null without tools or under tool_choice none", () => {
    expect(toJsonSchemaToolRequest({ prompt: "p" })).toBeNull();
    expect(toJsonSchemaToolRequest({ ...base, toolChoice: "none" })).toBeNull();
  });

  it("narrows to the forced tool and offers no answer", () => {
    const plan = toJsonSchemaToolRequest({
      ...base,
      toolChoice: { type: "function", function: { name: "os__fs__read" } },
    })!;
    const branches = itemsOf(plan.wireRequest.responseFormat!.schema);
    expect(branches).toHaveLength(1);
    expect([...plan.offeredNames]).toEqual(["os__fs__read"]);
    expect(plan.wireRequest.prompt).toContain("This step must call a tool.");
  });

  it("caps the batch at one call when parallel calls are off", () => {
    const plan = toJsonSchemaToolRequest({ ...base, parallelToolCalls: false })!;
    const calls = (plan.wireRequest.responseFormat!.schema.properties as Record<
      string,
      Record<string, unknown>
    >).calls!;
    expect(calls.maxItems).toBe(1);
  });
});

describe("parseJsonSchemaToolReply", () => {
  it("reads calls into OpenAI tool_calls with JSON-string arguments", () => {
    const reply = parseJsonSchemaToolReply(
      '{"calls":[{"name":"os__fs__read","arguments":{"path":"a.txt"}},{"name":"reply","arguments":{"text":"hi"}}]}',
    );
    expect(reply).toEqual({
      kind: "calls",
      calls: [
        {
          id: "json_schema_call_0",
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
        },
        {
          id: "json_schema_call_1",
          type: "function",
          function: { name: "reply", arguments: '{"text":"hi"}' },
        },
      ],
    });
  });

  it("reads the plain answer branch", () => {
    expect(parseJsonSchemaToolReply('{"calls":[{"answer":"Done."}]}')).toEqual({
      kind: "answer",
      text: "Done.",
    });
  });

  it("prefers a call over an answer written beside it", () => {
    const reply = parseJsonSchemaToolReply(
      '{"calls":[{"answer":"reading"},{"name":"os__fs__read","arguments":{"path":"a"}}]}',
    );
    expect(reply.kind).toBe("calls");
  });

  it("tolerates a bare array, a single call, tool/args spellings and a code fence", () => {
    expect(
      parseJsonSchemaToolReply('[{"tool":"os__fs__read","args":{"path":"a"}}]'),
    ).toMatchObject({ kind: "calls", calls: [{ function: { name: "os__fs__read" } }] });
    expect(
      parseJsonSchemaToolReply('{"name":"os__fs__read","arguments":{"path":"a"}}'),
    ).toMatchObject({ kind: "calls" });
    expect(
      parseJsonSchemaToolReply('```json\n{"calls":[{"answer":"ok"}]}\n```'),
    ).toEqual({ kind: "answer", text: "ok" });
  });

  it("refuses truncated JSON, prose, and an empty answer", () => {
    expect(
      parseJsonSchemaToolReply('{"calls":[{"name":"os__fs__read","arguments":{"path":"a'),
    ).toEqual({ kind: "unreadable" });
    expect(parseJsonSchemaToolReply("Sure, reading it now.")).toEqual({
      kind: "unreadable",
    });
    expect(parseJsonSchemaToolReply('{"calls":[{"answer":"  "}]}')).toEqual({
      kind: "unreadable",
    });
    expect(parseJsonSchemaToolReply("")).toEqual({ kind: "unreadable" });
  });
});

describe("applyJsonSchemaToolReply", () => {
  it("turns calls into toolCalls and clears the JSON text", () => {
    const out = applyJsonSchemaToolReply(
      result('{"calls":[{"name":"os__fs__read","arguments":{"path":"a"}}]}'),
    );
    expect(out.content).toBe("");
    expect(out.finishReason).toBe("tool_calls");
    expect(out.toolCalls?.[0]?.function.name).toBe("os__fs__read");
  });

  it("turns the answer into plain content", () => {
    const out = applyJsonSchemaToolReply(result('{"calls":[{"answer":"Hello."}]}'));
    expect(out.content).toBe("Hello.");
    expect(out.toolCalls).toBeUndefined();
  });

  it("leaves an unreadable reply as it came", () => {
    const original = result("plain prose");
    expect(applyJsonSchemaToolReply(original)).toBe(original);
  });

  it("keeps the truncation finish reason on a cut reply", () => {
    const out = applyJsonSchemaToolReply(
      result('{"calls":[{"name":"reply","arguments":{"text":"x"}}]}', {
        truncated: true,
        finishReason: "length",
      }),
    );
    expect(out.finishReason).toBe("length");
  });
});
