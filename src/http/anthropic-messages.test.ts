import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import {
  AnthropicStreamTranslator,
  anthropicContentToText,
  anthropicError,
  anthropicToChatRequest,
  chatCompletionToAnthropic,
  estimateAnthropicInputTokens,
} from "./anthropic-messages.js";
import { SESSION_ID_HEADER } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-1080: `POST /v1/messages`, the Anthropic Messages API on the chat-completions turn path. */

describe("anthropicToChatRequest", () => {
  it("maps system (string or blocks), roles and text blocks", () => {
    const mapped = anthropicToChatRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: [{ type: "text", text: "Be brief." }, { type: "text", text: "Use English." }],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "what now?" }] },
      ],
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.model).toBe("claude-sonnet-4-5");
    expect(mapped.body.messages).toEqual([
      { role: "system", content: "Be brief.\n\nUse English." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "what now?" },
    ]);
    expect(mapped.body.stream).toBe(false);
    expect(mapped.body.stream_options).toBeUndefined();
  });

  it("asks the inner stream for usage when streaming", () => {
    const mapped = anthropicToChatRequest({ stream: true, messages: [{ role: "user", content: "x" }] });
    expect(mapped.ok && mapped.body.stream_options).toEqual({ include_usage: true });
    expect(mapped.ok && mapped.model).toBe("atomic-agent");
  });

  it("accepts client tools without passing them on", () => {
    const mapped = anthropicToChatRequest({
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(Object.keys(mapped.body)).not.toContain("tools");
    expect(Object.keys(mapped.body)).not.toContain("tool_choice");
  });

  it("keeps tool_use and tool_result history as text", () => {
    const mapped = anthropicToChatRequest({
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file body" }] },
            { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "denied" },
          ],
        },
      ],
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.body.messages[1]).toEqual({
      role: "assistant",
      content: 'Reading.\n\n[tool call Read: {"path":"a.txt"}]',
    });
    expect(mapped.body.messages[2]).toEqual({
      role: "user",
      content: "[tool result toolu_1]: file body\n\n[tool error toolu_2]: denied",
    });
  });

  it("drops thinking blocks and marks images", () => {
    expect(
      anthropicContentToText([
        { type: "thinking", thinking: "hmm" },
        { type: "image", source: { type: "base64", data: "AAAA" } },
        { type: "text", text: "see this" },
      ]),
    ).toBe("[image omitted]\n\nsee this");
  });

  it("refuses a request with no messages", () => {
    expect(anthropicToChatRequest({ model: "m" }).ok).toBe(false);
    expect(anthropicToChatRequest({ messages: [] }).ok).toBe(false);
  });

  it("passes session_id and working_dir through", () => {
    const mapped = anthropicToChatRequest({
      messages: [{ role: "user", content: "x" }],
      session_id: "s-1",
      working_dir: "/tmp",
    });
    expect(mapped.ok && mapped.body.session_id).toBe("s-1");
    expect(mapped.ok && mapped.body.working_dir).toBe("/tmp");
  });
});

describe("chatCompletionToAnthropic", () => {
  const opts = { id: "msg_1", model: "claude-x" };

  it("maps content, stop reason and usage", () => {
    const message = chatCompletionToAnthropic(
      {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
      opts,
    );
    expect(message).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 2 },
    });
  });

  it("length is max_tokens; an empty reply has no content blocks", () => {
    const message = chatCompletionToAnthropic({ choices: [{ message: { content: "" }, finish_reason: "length" }] }, opts);
    expect(message["stop_reason"]).toBe("max_tokens");
    expect(message["content"]).toEqual([]);
  });

  it("never says tool_use: the agent's own tools stay on its side", () => {
    const message = chatCompletionToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, opts);
    expect(message["stop_reason"]).not.toBe("tool_use");
  });
});

describe("anthropicError", () => {
  it("maps statuses onto Anthropic error types", () => {
    expect(anthropicError(400, "m").error.type).toBe("invalid_request_error");
    expect(anthropicError(401, "m").error.type).toBe("authentication_error");
    expect(anthropicError(429, "m").error.type).toBe("rate_limit_error");
    expect(anthropicError(500, "m")).toEqual({ type: "error", error: { type: "api_error", message: "m" } });
  });
});

describe("AnthropicStreamTranslator", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
    JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage });

  it("produces the full Anthropic event sequence", () => {
    const tr = new AnthropicStreamTranslator({ id: "msg_1", model: "claude-x" });
    const events = [
      ...tr.start(),
      ...tr.push(chunk({ role: "assistant" })),
      ...tr.push(chunk({ content: "Hel" })),
      ...tr.push(chunk({ content: "lo" })),
      ...tr.push(chunk({}, "stop")),
      ...tr.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } })),
      ...tr.push("[DONE]"),
    ];
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]?.data["message"]).toMatchObject({ id: "msg_1", role: "assistant", model: "claude-x", content: [] });
    expect(events[2]?.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
    expect(events[5]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 11, output_tokens: 4 },
    });
    for (const e of events) expect(e.data["type"]).toBe(e.event);
  });

  it("a reply with no text still closes cleanly, without a content block", () => {
    const tr = new AnthropicStreamTranslator({ id: "m", model: "x" });
    const events = [...tr.start(), ...tr.push(chunk({}, "length")), ...tr.push("[DONE]")];
    expect(events.map((e) => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
    expect((events[1]?.data["delta"] as { stop_reason: string }).stop_reason).toBe("max_tokens");
  });

  it("an error nothing follows is a failed turn: one error event ends the sequence", () => {
    const tr = new AnthropicStreamTranslator({ id: "m", model: "x" });
    tr.start();
    tr.push(chunk({ content: "part" }));
    expect(tr.push(JSON.stringify({ error: { message: "Agent loop failed: boom", type: "server_error" } }))).toEqual([]);
    expect(tr.push(chunk({}, "stop"))).toEqual([]);
    expect(tr.push("[DONE]")).toEqual([
      { event: "error", data: { type: "error", error: { type: "api_error", message: "Agent loop failed: boom" } } },
    ]);
    expect(tr.finishEvents()).toEqual([]);
  });

  it("an error followed by more text was a retried step and is dropped", () => {
    const tr = new AnthropicStreamTranslator({ id: "m", model: "x" });
    tr.start();
    tr.push(JSON.stringify({ error: { message: "step failed", type: "agent.transport" } }));
    tr.push(chunk({ content: "recovered" }));
    const end = [...tr.push(chunk({}, "stop")), ...tr.push("[DONE]")];
    expect(end.map((e) => e.event)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
  });

  it("ignores tool_calls deltas: the text is the only content", () => {
    const tr = new AnthropicStreamTranslator({ id: "m", model: "x" });
    tr.start();
    const events = tr.push(chunk({ tool_calls: [{ index: 0, function: { name: "shell", arguments: "{}" } }] }));
    expect(events).toEqual([]);
  });

  it("an inner stream that ends without [DONE] is still closed", () => {
    const tr = new AnthropicStreamTranslator({ id: "m", model: "x" });
    tr.start();
    tr.push(chunk({ content: "a" }));
    expect(tr.finishEvents().map((e) => e.event)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
  });
});

describe("estimateAnthropicInputTokens", () => {
  it("counts system, messages and tools at about four characters a token", () => {
    expect(estimateAnthropicInputTokens({ system: "abcd", messages: [{ role: "user", content: "efgh" }] })).toBe(2);
    expect(estimateAnthropicInputTokens({})).toBe(0);
  });
});

function scriptedLlama(replies: string[]) {
  const queue = [...replies];
  return async (): Promise<CompletionResult> => ({
    content: JSON.stringify({ tool: "reply", args: { text: queue.shift() ?? "fallback" } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });
}

function parseSse(text: string): Array<{ event: string | null; data: Record<string, unknown> }> {
  const out: Array<{ event: string | null; data: Record<string, unknown> }> = [];
  for (const frame of text.split("\n\n")) {
    let event: string | null = null;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

describe("POST /v1/messages (through the server)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ llamaComplete: scriptedLlama(["hi back", "again"]), apiKey: "k".repeat(16) });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const post = (body: unknown, headers: Record<string, string> = { "x-api-key": "k".repeat(16) }) =>
    fetch(`${harness.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify(body),
    });

  it("answers an Anthropic message, authenticated by x-api-key", async () => {
    const response = await post({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get(SESSION_ID_HEADER.toLowerCase())).toBeTruthy();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi back" }],
      stop_reason: "end_turn",
    });
    expect(String(body["id"])).toMatch(/^msg_[0-9a-f]{24}$/);
  });

  it("refuses a wrong key and a bad body in Anthropic's error shape", async () => {
    expect((await post({ messages: [{ role: "user", content: "x" }] }, { "x-api-key": "nope" })).status).toBe(401);
    const bad = await post({ model: "m" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });

  it("streams the Anthropic event sequence", async () => {
    const response = await post({ stream: true, max_tokens: 100, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = parseSse(await response.text());
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names.slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(names).not.toContain("error");
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data["delta"] as { text: string }).text)
      .join("");
    expect(text).toBe("hi back");
  });

  it("the same opening message continues the same chat", async () => {
    const first = await post({ messages: [{ role: "user", content: "hello" }] });
    const session = first.headers.get(SESSION_ID_HEADER.toLowerCase());
    await first.json();
    const second = await post({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi back" },
        { role: "user", content: "more" },
      ],
    });
    expect(second.headers.get(SESSION_ID_HEADER.toLowerCase())).toBe(session);
    expect(second.status).toBe(200);
    await second.json();
  });

  it("count_tokens answers an estimate", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"k".repeat(16)}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "12345678" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 2 });
  });
});
