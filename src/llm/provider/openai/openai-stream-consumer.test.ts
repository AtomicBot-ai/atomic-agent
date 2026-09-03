import { describe, expect, it } from "vitest";

import { createOpenAiStreamConsumer } from "./openai-stream-consumer.js";
import type { StreamFinalResult } from "../completion-types.js";

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallFrame(
  toolCalls: Array<Record<string, unknown>>,
): string {
  return sseFrame({
    model: "test-model",
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  });
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Drain the consumer and return the final result it returns on completion. */
async function drain(body: string): Promise<StreamFinalResult> {
  const consumer = createOpenAiStreamConsumer("delta_reasoning");
  const iterator = consumer.consume(bodyOf(body), undefined);
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value as StreamFinalResult;
  }
}

const DONE = sseFrame({
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
}) + "data: [DONE]\n\n";

describe("openai stream consumer tool-call assembly", () => {
  it("keeps unindexed calls with distinct ids apart", async () => {
    const result = await drain(
      toolCallFrame([
        {
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
        },
      ]) +
        toolCallFrame([
          {
            id: "call_b",
            type: "function",
            function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
          },
        ]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
      },
    ]);
  });

  it("reassembles fragments of one unindexed call that repeats its id", async () => {
    const result = await drain(
      toolCallFrame([
        { id: "call_a", type: "function", function: { name: "os__fs__read" } },
      ]) +
        toolCallFrame([{ id: "call_a", function: { arguments: '{"path":' } }]) +
        toolCallFrame([{ id: "call_a", function: { arguments: '"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("still folds id-less continuation deltas into the open call", async () => {
    const result = await drain(
      toolCallFrame([
        { id: "call_a", type: "function", function: { name: "os__fs__read" } },
      ]) +
        toolCallFrame([{ function: { arguments: '{"path":"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("accumulates indexed parallel calls in index order, whatever the arrival order", async () => {
    const result = await drain(
      toolCallFrame([
        {
          index: 1,
          id: "call_b",
          type: "function",
          function: { name: "os__fs__grep", arguments: '{"pattern"' },
        },
      ]) +
        toolCallFrame([
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "os__fs__read", arguments: '{"path"' },
          },
        ]) +
        toolCallFrame([{ index: 1, function: { arguments: ':"b"}' } }]) +
        toolCallFrame([{ index: 0, function: { arguments: ':"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
      },
    ]);
  });

  it("merges an id-only delta into the slot the provider opened by index", async () => {
    const result = await drain(
      toolCallFrame([
        {
          index: 0,
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read" },
        },
      ]) +
        toolCallFrame([{ id: "call_a", function: { arguments: '{"path":"a.txt"}' } }]) +
        DONE,
    );

    expect(result.toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("keeps two unindexed calls in a single event apart", async () => {
    const result = await drain(
      toolCallFrame([
        {
          id: "call_a",
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "os__fs__grep", arguments: '{"pattern":"b"}' },
        },
      ]) + DONE,
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.map((call) => call.id)).toEqual(["call_a", "call_b"]);
  });
});
