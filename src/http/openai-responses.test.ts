import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { SESSION_ID_HEADER } from "./openai-chat-completions.js";
import {
  ResponsesStreamTranslator,
  chatCompletionToResponse,
  makeResponseId,
  responsesToChatRequest,
  sessionIdFromResponseId,
} from "./openai-responses.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-1080: `POST /v1/responses`, the OpenAI Responses API on the chat-completions turn path. */

describe("response ids", () => {
  it("carry their session and read it back", () => {
    const id = makeResponseId("api-abc123");
    expect(id).toMatch(/^resp_[0-9a-f]{24}_/);
    expect(sessionIdFromResponseId(id)).toBe("api-abc123");
    expect(makeResponseId("api-abc123")).not.toBe(id);
  });

  it("refuse ids that are not ours", () => {
    expect(sessionIdFromResponseId("resp_123")).toBeNull();
    expect(sessionIdFromResponseId("chatcmpl-x")).toBeNull();
    const withNewline = `resp_${"a".repeat(24)}_${Buffer.from("a\nb").toString("base64url")}`;
    expect(sessionIdFromResponseId(withNewline)).toBeNull();
  });
});

describe("responsesToChatRequest", () => {
  it("maps a string input and instructions", () => {
    const mapped = responsesToChatRequest({ model: "gpt-5", instructions: "Be brief.", input: "hello" });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.model).toBe("gpt-5");
    expect(mapped.instructions).toBe("Be brief.");
    expect(mapped.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);
  });

  it("maps message items, developer role and content parts", () => {
    const mapped = responsesToChatRequest({
      input: [
        { role: "developer", content: "rules" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "x" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        { type: "reasoning", summary: [] },
        { role: "user", content: "next" },
      ],
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.body.messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "hi\n\n[image omitted]" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "next" },
    ]);
  });

  it("keeps function_call and function_call_output items as text, and drops client tools", () => {
    const mapped = responsesToChatRequest({
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [
        { role: "user", content: "list" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      ],
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.body.messages.slice(1)).toEqual([
      { role: "assistant", content: '[tool call shell: {"cmd":"ls"}]' },
      { role: "user", content: "[tool result call_1]: a.txt" },
    ]);
    expect(Object.keys(mapped.body)).not.toContain("tools");
  });

  it("previous_response_id becomes the session of that response", () => {
    const previous = makeResponseId("api-sess");
    const mapped = responsesToChatRequest({ input: "more", previous_response_id: previous, stream: true });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.body.session_id).toBe("api-sess");
    expect(mapped.previousResponseId).toBe(previous);
    expect(mapped.body.stream_options).toEqual({ include_usage: true });
  });

  it("refuses an unknown previous_response_id, a missing input and an input with no user text", () => {
    const unknown = responsesToChatRequest({ input: "x", previous_response_id: "resp_nope" });
    expect(unknown).toEqual({ ok: false, message: "Previous response not found", param: "previous_response_id" });
    expect(responsesToChatRequest({}).ok).toBe(false);
    expect(responsesToChatRequest({ input: [{ role: "assistant", content: "only me" }] }).ok).toBe(false);
  });
});

const opts = {
  id: "resp_1",
  itemId: "msg_1",
  model: "gpt-5",
  createdAt: 100,
  previousResponseId: null,
  instructions: null,
};

describe("chatCompletionToResponse", () => {
  it("maps text, status and usage", () => {
    const response = chatCompletionToResponse(
      {
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      },
      opts,
    );
    expect(response).toMatchObject({
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-5",
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    });
  });

  it("a turn that ran out of steps is incomplete", () => {
    const response = chatCompletionToResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }, opts);
    expect(response["status"]).toBe("incomplete");
    expect(response["incomplete_details"]).toEqual({ reason: "max_output_tokens" });
  });

  it("output never holds a function_call: the agent's own tools stay on its side", () => {
    const response = chatCompletionToResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, opts);
    expect((response["output"] as Array<{ type: string }>).map((o) => o.type)).toEqual(["message"]);
  });
});

describe("ResponsesStreamTranslator", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });

  it("produces the Responses event sequence with growing sequence numbers", () => {
    const tr = new ResponsesStreamTranslator({ ...opts });
    const events = [
      ...tr.start(),
      ...tr.push(chunk({ role: "assistant" })),
      ...tr.push(chunk({ content: "Hel" })),
      ...tr.push(chunk({ content: "lo" })),
      ...tr.push(chunk({}, "stop")),
      ...tr.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })),
      ...tr.push("[DONE]"),
    ];
    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    events.forEach((e, i) => {
      expect(e.data["type"]).toBe(e.event);
      expect(e.data["sequence_number"]).toBe(i);
    });
    expect(events[4]?.data).toMatchObject({ item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" });
    expect(events[6]?.data["text"]).toBe("Hello");
    const done = events[9]?.data["response"] as Record<string, unknown>;
    expect(done["status"]).toBe("completed");
    expect(done["usage"]).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
    expect((events[0]?.data["response"] as Record<string, unknown>)["status"]).toBe("in_progress");
  });

  it("an empty reply still produces the message item, ending incomplete on length", () => {
    const tr = new ResponsesStreamTranslator({ ...opts });
    const events = [...tr.start(), ...tr.push(chunk({}, "length")), ...tr.push("[DONE]")];
    expect(events.map((e) => e.event)).toContain("response.output_item.added");
    expect(events.at(-1)?.event).toBe("response.incomplete");
  });

  it("an error nothing follows ends it with response.failed", () => {
    const tr = new ResponsesStreamTranslator({ ...opts });
    tr.start();
    expect(tr.push(JSON.stringify({ error: { message: "boom", type: "server_error" } }))).toEqual([]);
    tr.push(chunk({}, "stop"));
    const events = tr.push("[DONE]");
    expect(events.map((e) => e.event)).toEqual(["response.failed"]);
    expect(events[0]?.data["response"]).toMatchObject({ status: "failed", error: { code: "server_error", message: "boom" } });
    expect(tr.finishEvents()).toEqual([]);
  });

  it("an error followed by more text was a retried step and is dropped", () => {
    const tr = new ResponsesStreamTranslator({ ...opts });
    tr.start();
    tr.push(JSON.stringify({ error: { message: "step failed" } }));
    tr.push(chunk({ content: "ok" }));
    expect(tr.push("[DONE]").at(-1)?.event).toBe("response.completed");
  });

  it("ignores tool_calls deltas", () => {
    const tr = new ResponsesStreamTranslator({ ...opts });
    tr.start();
    expect(tr.push(chunk({ tool_calls: [{ index: 0, function: { name: "shell" } }] }))).toEqual([]);
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

describe("POST /v1/responses (through the server)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ llamaComplete: scriptedLlama(["hi back"]) });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const post = (body: unknown) =>
    fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers a response whose id continues the same chat", async () => {
    const response = await post({ model: "gpt-5", input: "hello" });
    expect(response.status).toBe(200);
    const session = response.headers.get(SESSION_ID_HEADER.toLowerCase());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      model: "gpt-5",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi back" }] }],
    });
    expect(sessionIdFromResponseId(String(body["id"]))).toBe(session);

    const next = await post({ input: "more", previous_response_id: body["id"] });
    expect(next.status).toBe(200);
    expect(next.headers.get(SESSION_ID_HEADER.toLowerCase())).toBe(session);
    expect(((await next.json()) as Record<string, unknown>)["previous_response_id"]).toBe(body["id"]);
  });

  it("refuses an unknown previous_response_id in OpenAI's error shape", async () => {
    const response = await post({ input: "x", previous_response_id: "resp_unknown" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { param: "previous_response_id", type: "invalid_request_error" } });
  });

  it("streams the Responses event sequence", async () => {
    const response = await post({ input: "hello", stream: true });
    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    expect(events[0]?.event).toBe("response.created");
    expect(events.at(-1)?.event).toBe("response.completed");
    const text = events
      .filter((e) => e.event === "response.output_text.delta")
      .map((e) => String(e.data["delta"]))
      .join("");
    expect(text).toBe("hi back");
    const created = events[0]?.data["response"] as { id: string };
    expect(sessionIdFromResponseId(created.id)).toBe(response.headers.get(SESSION_ID_HEADER.toLowerCase()));
  });
});
