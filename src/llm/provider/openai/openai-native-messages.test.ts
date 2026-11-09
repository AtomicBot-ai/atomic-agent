import { describe, expect, it } from "vitest";

import type { PromptMessages } from "../completion-types.js";
import { OpenAiHttpError } from "./openai-http.js";
import { estimateTokens } from "../../../prompt/token-budget.js";
import {
  NO_RESULT_RECORDED,
  PRESERVED_REASONING_TOKEN_BUDGET,
  buildNativeMessages,
  capPreservedReasoning,
  isNativeShapeRejection,
} from "./openai-native-messages.js";
import { nameEscape } from "./openai-tool-call-adapter.js";

const options = { nameEscape };

function prompt(overrides: Partial<PromptMessages>): PromptMessages {
  return {
    system: "### system\nprefix",
    droppedSummary: null,
    turns: [],
    tail: "### world\n(none)\n\n### respond\nRespond now.\n",
    ...overrides,
  };
}

describe("buildNativeMessages", () => {
  it("lays the packed turns out as system, real turns and one final user message", () => {
    const messages = buildNativeMessages(
      prompt({
        turns: [
          { kind: "user", text: "read a.txt" },
          { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" } },
          { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "hello", truncated: false },
          { kind: "assistant_reply", text: "it says hello" },
          { kind: "user", text: "now b.txt" },
        ],
      }),
      options,
    );
    expect(messages).toEqual([
      { role: "system", content: "### system\nprefix" },
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
      { role: "assistant", content: "it says hello" },
      { role: "user", content: "now b.txt" },
      { role: "user", content: "### world\n(none)\n\n### respond\nRespond now.\n" },
    ]);
  });

  it("ids calls by their row index, so an append-only history keeps its ids", () => {
    const turns: PromptMessages["turns"] = [
      { kind: "user", text: "go" },
      { kind: "assistant_tool_call", tool: "a", args: {} },
      { kind: "tool_result", tool: "a", status: "ok", body: "1", truncated: false },
    ];
    const before = buildNativeMessages(prompt({ turns }), options);
    const after = buildNativeMessages(
      prompt({
        turns: [
          ...turns,
          { kind: "assistant_tool_call", tool: "b", args: {} },
          { kind: "tool_result", tool: "b", status: "ok", body: "2", truncated: false },
        ],
      }),
      options,
    );
    // Everything but the final user message is a prefix of the next request.
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect((after[4] as { tool_calls: Array<{ id: string }> }).tool_calls[0]?.id).toBe("call_3");
  });

  it("carries the error status and the truncation note on a tool message", () => {
    const messages = buildNativeMessages(
      prompt({
        turns: [
          { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "x" } },
          { kind: "tool_result", tool: "os.shell.run", status: "error", body: "exit 1", truncated: true },
        ],
      }),
      options,
    );
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_0",
      content: "error: exit 1 (truncated)",
    });
  });

  it("answers a call the history has no result for before anything follows it", () => {
    const messages = buildNativeMessages(
      prompt({
        turns: [
          { kind: "assistant_tool_call", tool: "a", args: {} },
          { kind: "user", text: "steer" },
          { kind: "assistant_tool_call", tool: "b", args: {} },
        ],
      }),
      options,
    );
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_0", content: NO_RESULT_RECORDED });
    expect(messages[5]).toEqual({ role: "tool", tool_call_id: "call_2", content: NO_RESULT_RECORDED });
  });

  it("carries a result whose call was cut away as the flat line, in a user message", () => {
    const messages = buildNativeMessages(
      prompt({
        droppedSummary: "summary: 3 older turns dropped",
        turns: [
          { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "tail of a read", truncated: true },
          { kind: "tool_result", tool: "os.fs.list", status: "error", body: "nope", truncated: false },
          { kind: "assistant_reply", text: "done" },
        ],
      }),
      options,
    );
    expect(messages).toEqual([
      { role: "system", content: "### system\nprefix" },
      { role: "user", content: "summary: 3 older turns dropped" },
      {
        role: "user",
        content:
          "tool_result[os.fs.read ok]: tail of a read (truncated)\ntool_result[os.fs.list error]: nope",
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "### world\n(none)\n\n### respond\nRespond now.\n" },
    ]);
  });

  it("sends system and the tail alone for an empty conversation", () => {
    expect(buildNativeMessages(prompt({}), options)).toEqual([
      { role: "system", content: "### system\nprefix" },
      { role: "user", content: "### world\n(none)\n\n### respond\nRespond now.\n" },
    ]);
  });
});

describe("buildNativeMessages: reasoning handed back (ATO-887)", () => {
  const turns: PromptMessages["turns"] = [
    { kind: "user", text: "read a.txt" },
    { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" }, reasoning: "need the file first" },
    { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "hello", truncated: false },
  ];

  it("puts the call's reasoning on its assistant message as reasoning_content", () => {
    const messages = buildNativeMessages(prompt({ turns }), { ...options, preserveReasoning: true });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "need the file first",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' } },
      ],
    });
  });

  it("leaves it out unless asked, so a strict API never sees the field", () => {
    const messages = buildNativeMessages(prompt({ turns }), options);
    expect(messages[2]).not.toHaveProperty("reasoning_content");
  });

  it("adds nothing for a call that has no reasoning", () => {
    const plain: PromptMessages["turns"] = [
      { kind: "user", text: "read a.txt" },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" } },
    ];
    const messages = buildNativeMessages(prompt({ turns: plain }), { ...options, preserveReasoning: true });
    expect(messages[2]).not.toHaveProperty("reasoning_content");
  });
});

describe("capPreservedReasoning: reasoning handed back stays within a fixed budget (ATO-887)", () => {
  const call = (reasoning?: string): PromptMessages["turns"][number] => ({
    kind: "assistant_tool_call",
    tool: "os.fs.read",
    args: { path: "a.txt" },
    ...(reasoning !== undefined ? { reasoning } : {}),
  });
  const result: PromptMessages["turns"][number] = {
    kind: "tool_result",
    tool: "os.fs.read",
    status: "ok",
    body: "hello",
    truncated: false,
  };
  const words = (count: number, tag: string): string =>
    Array.from({ length: count }, (_, i) => `${tag}${i}`).join(" ");

  it("is a named budget of 2048 estimated tokens", () => {
    expect(PRESERVED_REASONING_TOKEN_BUDGET).toBe(2048);
  });

  it("keeps every call's reasoning whole while the total fits", () => {
    const turns = [{ kind: "user", text: "go" } as const, call("first"), result, call("second"), result];
    const kept = capPreservedReasoning(turns);
    expect(kept.get(1)).toBe("first");
    expect(kept.get(3)).toBe("second");
  });

  it("gives the budget to the newest calls and drops older reasoning entirely", () => {
    const older = words(600, "old");
    const newer = words(600, "new");
    const turns = [call(older), result, call(older), result, call(newer), result];
    const budget = estimateTokens(newer) + 10;
    const kept = capPreservedReasoning(turns, budget);
    expect(kept.get(4)).toBe(newer);
    // The next call does not fit whole, so only its tail is kept.
    const cut = kept.get(2)!;
    expect(older.endsWith(cut)).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(10);
    // Nothing older than the cut call survives.
    expect(kept.has(0)).toBe(false);
  });

  it("cuts a single oversized newest reasoning from the start, keeping its tail", () => {
    const huge = words(5000, "w");
    const kept = capPreservedReasoning([call(huge)]);
    const tail = kept.get(0)!;
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(huge.length);
    expect(huge.endsWith(tail)).toBe(true);
    expect(tail.endsWith("w4999")).toBe(true);
    expect(estimateTokens(tail)).toBeLessThanOrEqual(PRESERVED_REASONING_TOKEN_BUDGET);
  });

  it("keeps the total of a long tool loop within the budget", () => {
    const turns: Array<PromptMessages["turns"][number]> = [{ kind: "user", text: "go" }];
    for (let i = 0; i < 40; i++) turns.push(call(words(300, `s${i}_`)), result);
    const kept = capPreservedReasoning(turns);
    const total = [...kept.values()].reduce((sum, text) => sum + estimateTokens(text), 0);
    expect(total).toBeLessThanOrEqual(PRESERVED_REASONING_TOKEN_BUDGET);
    // The newest call is always among the kept ones.
    expect(kept.has(turns.length - 2)).toBe(true);
  });

  it("buildNativeMessages applies the cap to reasoning_content", () => {
    const huge = words(5000, "w");
    const messages = buildNativeMessages(
      prompt({ turns: [{ kind: "user", text: "go" }, call(words(50, "old")), result, call(huge)] }),
      { ...options, preserveReasoning: true },
    );
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
    const content = assistants[1]!.reasoning_content as string;
    expect(huge.endsWith(content)).toBe(true);
    expect(estimateTokens(content)).toBeLessThanOrEqual(PRESERVED_REASONING_TOKEN_BUDGET);
  });
});

describe("isNativeShapeRejection", () => {
  const http = (status: number | null, message: string) =>
    new OpenAiHttpError(message, status, "http://x", false, null, "p");

  it("names a 400 about roles, tool_call_id or messages", () => {
    expect(isNativeShapeRejection(http(400, 'openai provider 400: {"error":"Unknown role: tool"}'))).toBe(true);
    expect(isNativeShapeRejection(http(400, "openai provider 400: invalid tool_call_id"))).toBe(true);
    expect(isNativeShapeRejection(http(400, "openai provider 400: messages[2] must be a user message"))).toBe(true);
    expect(isNativeShapeRejection(http(400, "openai provider 400: tool_calls is not supported"))).toBe(true);
  });

  it("leaves every other failure to its own handling", () => {
    expect(isNativeShapeRejection(http(400, "openai provider 400: maximum context length is 8192 tokens"))).toBe(false);
    expect(isNativeShapeRejection(http(422, "openai provider 422: role"))).toBe(false);
    expect(isNativeShapeRejection(http(null, "fetch failed: roles"))).toBe(false);
    expect(isNativeShapeRejection(new Error("role"))).toBe(false);
    expect(isNativeShapeRejection("role")).toBe(false);
  });
});
