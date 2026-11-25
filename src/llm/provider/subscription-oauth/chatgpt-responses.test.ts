import { describe, expect, it } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import {
  DEFAULT_INSTRUCTIONS,
  buildChatgptResponsesBody,
  chatMessageToItems,
  parseChatgptEvent,
  readSseEvents,
  toResponsesTool,
} from "./chatgpt-responses.js";

const TOOL = {
  type: "function",
  function: {
    name: "os__fs__read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("buildChatgptResponsesBody", () => {
  it("sends a flat prompt as one user message with the backend's required fields", () => {
    const body = buildChatgptResponsesBody({ prompt: "hello", maxTokens: 50, temperature: 0.3 }, { model: "gpt-x" });
    expect(body).toMatchObject({
      model: "gpt-x",
      instructions: DEFAULT_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
      stream: true,
      tool_choice: "auto",
    });
    // The backend refuses an output cap; Codex sends no temperature.
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tools");
  });

  it("lays a native-tools history out as Responses items, system text as instructions", () => {
    const request: CompletionRequest = {
      prompt: "flat",
      tools: [TOOL],
      sessionId: "sess-1",
      messages: {
        system: "You are the agent.",
        droppedSummary: null,
        turns: [
          { kind: "user", text: "read a.txt" },
          { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" }, callId: "call_a" },
          { kind: "tool_result", tool: "os.fs.read", status: "ok", body: "contents", truncated: false, callId: "call_a" },
        ],
        tail: "Respond now.",
      },
    };
    const body = buildChatgptResponsesBody(request, { model: "gpt-x" });
    expect(body.instructions).toBe("You are the agent.");
    expect(body.prompt_cache_key).toBe("sess-1");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a.txt" }] },
      { type: "function_call", call_id: "call_a", name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_a", output: "contents" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Respond now." }] },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "os__fs__read",
        description: "Read a file",
        parameters: TOOL.function.parameters,
        strict: false,
      },
    ]);
  });

  it("asks for the reasoning effort the turn picked", () => {
    const body = buildChatgptResponsesBody({ prompt: "p", reasoningEffort: "high" }, { model: "m" });
    expect(body.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("spells structured outputs as text.format when there are no tools", () => {
    const body = buildChatgptResponsesBody(
      { prompt: "p", responseFormat: { name: "verdict", schema: { type: "object" } } },
      { model: "m" },
    );
    expect(body.text).toEqual({ format: { type: "json_schema", name: "verdict", schema: { type: "object" }, strict: true } });
  });

  it("refuses a body that cannot fit the window, like the chat builder", () => {
    expect(() =>
      buildChatgptResponsesBody(
        {
          prompt: "x".repeat(10_000),
          modelMode: { mode: "cloud" } as CompletionRequest["modelMode"],
          contextBudget: { window: 1_000, replyReserve: 100 },
        },
        { model: "m" },
      ),
    ).toThrow(/exceeds context window/);
  });
});

describe("chatMessageToItems / toResponsesTool", () => {
  it("keeps assistant text before its calls", () => {
    expect(
      chatMessageToItems({
        role: "assistant",
        content: "on it",
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
      }),
    ).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
    ]);
  });

  it("keeps strict only where the tool asked for it", () => {
    expect(toResponsesTool({ type: "function", function: { name: "a", parameters: {}, strict: true } })?.strict).toBe(true);
    expect(toResponsesTool({ type: "web_search" })).toBeNull();
  });
});

describe("readSseEvents", () => {
  it("joins events split across chunks and CRLF lines", async () => {
    const events = [];
    for await (const event of readSseEvents(
      streamOf('event: response.created\r\ndata: {"a":', '1}\r\n\r\ndata: {"b":2}\n\n', 'data: {"c":3}'),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "response.created", data: '{"a":1}' },
      { data: '{"b":2}' },
      { data: '{"c":3}' },
    ]);
  });
});

describe("parseChatgptEvent", () => {
  it("reads text and reasoning deltas", () => {
    expect(parseChatgptEvent('{"type":"response.output_text.delta","delta":"Hi"}')).toEqual({ kind: "text", delta: "Hi" });
    expect(parseChatgptEvent('{"type":"response.reasoning_summary_text.delta","delta":"think","summary_index":0}')).toEqual({
      kind: "reasoning",
      delta: "think",
    });
  });

  it("reads a finished function call", () => {
    const step = parseChatgptEvent(
      JSON.stringify({
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "os__fs__read", arguments: '{"path":"a"}' },
      }),
    );
    expect(step).toEqual({
      kind: "tool_call",
      call: { id: "call_1", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
    });
  });

  it("reads usage off response.completed", () => {
    const step = parseChatgptEvent(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-x",
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5, total_tokens: 15 },
        },
      }),
    );
    expect(step).toEqual({
      kind: "done",
      model: "gpt-x",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4 },
    });
  });

  it("marks a reply cut at the output limit", () => {
    const step = parseChatgptEvent(
      JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
    );
    expect(step).toMatchObject({ kind: "done", incompleteReason: "max_output_tokens" });
  });

  it("turns response.failed and the content filter into failures", () => {
    expect(
      parseChatgptEvent(
        JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }),
      ),
    ).toEqual({ kind: "failure", failure: { kind: "failed", message: "boom", code: "server_error" } });
    expect(
      parseChatgptEvent(JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } })),
    ).toMatchObject({ kind: "failure", failure: { kind: "content_filter" } });
  });

  it("reads the plan windows off codex.rate_limits", () => {
    const step = parseChatgptEvent(
      JSON.stringify({
        type: "codex.rate_limits",
        rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 60 } },
      }),
      1_000,
    );
    expect(step).toEqual({
      kind: "rate_limits",
      windows: [expect.objectContaining({ scope: "subscription", usedPercent: 40, resetsAt: 61_000 })],
    });
  });

  it("ignores what it does not know and what is not JSON", () => {
    expect(parseChatgptEvent('{"type":"response.in_progress"}')).toEqual({ kind: "ignore" });
    expect(parseChatgptEvent("[DONE]")).toEqual({ kind: "ignore" });
    expect(parseChatgptEvent("not json")).toEqual({ kind: "ignore" });
  });
});
