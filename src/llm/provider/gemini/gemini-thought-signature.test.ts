import { describe, expect, it } from "vitest";

import type { StreamFinalResult } from "../completion-types.js";
import { createOpenAiStreamConsumer } from "../openai/openai-stream-consumer.js";
import { normaliseOpenAiChatResponse } from "../openai/openai-normalise-response.js";
import { openAiToolCallsToBatch } from "../openai/openai-tool-call-adapter.js";
import { buildNativeMessages } from "../openai/openai-native-messages.js";
import {
  SKIP_THOUGHT_SIGNATURE,
  readThoughtSignature,
} from "./gemini-thought-signature.js";

/** An opaque signature, as Gemini 3 sends one. */
const SIG = "CiQBcsjafD2xq0n3Hk9mZ1vW1yXQeH0p6s5h+e8r2rL4m0c=";

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Two parallel calls in one event, the first signed, as Gemini 3 streams them. */
const GEMINI_FRAMES = [
  frame({
    model: "gemini-3-flash",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            id: "fn_a", type: "function",
            function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
            extra_content: { google: { thought_signature: SIG } },
          },
          { id: "fn_b", type: "function", function: { name: "os__fs__read", arguments: '{"path":"b.txt"}' } },
        ],
      },
      finish_reason: null,
    }],
  }),
  frame({ model: "gemini-3-flash", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  "data: [DONE]\n\n",
];

async function drain(frames: readonly string[]): Promise<StreamFinalResult> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  const iterator = createOpenAiStreamConsumer("auto").consume(body);
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value as StreamFinalResult;
  }
}

describe("Gemini 3 thought signatures are read off the response (ATO-1680)", () => {
  it("keeps a streamed call's signature and leaves the unsigned parallel call bare", async () => {
    const result = await drain(GEMINI_FRAMES);
    expect(result.toolCalls?.map((c) => c.thoughtSignature)).toEqual([SIG, undefined]);
    expect(result.toolCalls?.[1]).not.toHaveProperty("thoughtSignature");
  });

  it("keeps a non-streamed call's signature", () => {
    const result = normaliseOpenAiChatResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{
            id: "fn_a", type: "function",
            function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
            extra_content: { google: { thought_signature: SIG } },
          }],
        },
      }],
    }, "gemini-3-flash");
    expect(result.toolCalls?.[0]?.thoughtSignature).toBe(SIG);
  });

  it("puts the step's signature on every parsed call of the batch", async () => {
    const result = await drain(GEMINI_FRAMES);
    const batch = openAiToolCallsToBatch(result.toolCalls!);
    expect(batch.calls.map((c) => c.thoughtSignature)).toEqual([SIG, SIG]);
  });

  it("reads nothing from a call without the field or with a malformed one", () => {
    expect(readThoughtSignature({ function: { name: "x" } })).toBeUndefined();
    expect(readThoughtSignature({ extra_content: { google: { thought_signature: 7 } } })).toBeUndefined();
    expect(readThoughtSignature({ extra_content: { google: { thought_signature: "" } } })).toBeUndefined();
    expect(readThoughtSignature({ extra_content: "x" })).toBeUndefined();
    expect(readThoughtSignature(null)).toBeUndefined();
  });
});

describe("Gemini 3 thought signatures go back on the history's calls (ATO-1680)", () => {
  const nameEscape = (n: string) => n.replace(/\./g, "__");
  const turns = [
    { kind: "user" as const, text: "read both" },
    { kind: "assistant_tool_call" as const, tool: "os.fs.read", args: { path: "a.txt" }, callId: "call_turn_1", thoughtSignature: SIG },
    { kind: "assistant_tool_call" as const, tool: "os.fs.read", args: { path: "b.txt" }, callId: "call_turn_2" },
    { kind: "tool_result" as const, tool: "os.fs.read", status: "ok" as const, body: "A", truncated: false, callId: "call_turn_1" },
    { kind: "tool_result" as const, tool: "os.fs.read", status: "ok" as const, body: "B", truncated: false, callId: "call_turn_2" },
    // Recorded before signatures were kept, or by another model.
    { kind: "assistant_tool_call" as const, tool: "os.fs.list", args: { path: "." }, callId: "call_turn_5" },
    { kind: "tool_result" as const, tool: "os.fs.list", status: "ok" as const, body: "a b", truncated: false, callId: "call_turn_5" },
  ];
  const prompt = { system: "sys", droppedSummary: null, turns, tail: "" };
  type Call = { id: string; extra_content?: unknown };
  const calls = (messages: ReturnType<typeof buildNativeMessages>) =>
    messages.filter((m) => m.role === "assistant").map((m) => m.tool_calls as Call[]);

  it("writes the signature back byte for byte on the first call, as Gemini sent it", () => {
    const [parallel, single] = calls(buildNativeMessages(prompt, { nameEscape, thoughtSignatures: true }));
    expect(parallel!.map((c) => c.id)).toEqual(["call_turn_1", "call_turn_2"]);
    expect(parallel![0]!.extra_content).toEqual({ google: { thought_signature: SIG } });
    expect(parallel![1]).not.toHaveProperty("extra_content");
    // No signature of its own: the documented skip value, so Gemini does not refuse it.
    expect(single![0]!.extra_content).toEqual({ google: { thought_signature: SKIP_THOUGHT_SIGNATURE } });
  });

  it("signs only the first call of a parallel set as the transcript records it, call and result in turn", () => {
    // appendBatchedTurns writes call, result, call, result, so each call
    // opens its own message; the unsigned second call gets the skip value.
    const interleaved = { ...prompt, turns: [turns[0]!, turns[1]!, turns[3]!, turns[2]!, turns[4]!] };
    const [first, second] = calls(buildNativeMessages(interleaved, { nameEscape, thoughtSignatures: true }));
    expect(first![0]!.extra_content).toEqual({ google: { thought_signature: SIG } });
    expect(second![0]!.extra_content).toEqual({ google: { thought_signature: SKIP_THOUGHT_SIGNATURE } });
  });

  it("sends no extra_content to any other service", () => {
    const messages = buildNativeMessages(prompt, { nameEscape });
    expect(JSON.stringify(messages)).not.toContain("extra_content");
  });
});
