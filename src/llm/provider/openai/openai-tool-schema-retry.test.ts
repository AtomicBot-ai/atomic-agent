import { describe, expect, it, vi } from "vitest";

import type { CompletionResult, StreamChunk } from "../completion-types.js";
import { humanizeOpenAiHttpError, OpenAiHttpError } from "./openai-http.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * ATO-1399: a local server that cannot use one tool's JSON schema
 * refuses the whole request. The request goes out once more without
 * that tool, with a warning naming it; anything unmatched fails as it
 * did before.
 */

const MODEL = "local-model";

const SCHEMA_500 = JSON.stringify({
  error:
    "JSON schema error at #/$defs/RecordSource/oneOf/1/properties/data: schema must be an object",
});

function json(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okUnary(): Response {
  return json(
    JSON.stringify({
      model: MODEL,
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
    }),
    200,
  );
}

function okStream(): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function scripted(responses: ReadonlyArray<() => Response>) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1];
    return next!();
  });
  return { fetchImpl, bodies };
}

function setup(responses: ReadonlyArray<() => Response>) {
  const { fetchImpl, bodies } = scripted(responses);
  const warn = vi.fn();
  const provider = new OpenAiProvider({
    id: "lmstudio",
    baseUrl: "http://127.0.0.1:1234",
    apiKey: "",
    defaultChatModel: MODEL,
    fetchImpl: fetchImpl as typeof fetch,
    logger: { warn },
  });
  return { provider, fetchImpl, bodies, warn };
}

/**
 * A schema the boolean rewrite leaves alone but this fake server still
 * refuses: `data` is a string where a subschema belongs.
 */
const BAD_TOOL = {
  type: "function",
  function: {
    name: "plugin__records__lookup",
    parameters: {
      type: "object",
      $defs: {
        RecordSource: {
          oneOf: [{ type: "object" }, { properties: { data: "anything" } }],
        },
      },
    },
  },
};

const GOOD_TOOL = {
  type: "function",
  function: {
    name: "os__fs__read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};

function names(body: Record<string, unknown>): string[] {
  return ((body.tools as any[]) ?? []).map((t) => t.function.name);
}

async function drain(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<CompletionResult> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
  }
}

describe("OpenAiProvider — drop a tool the server cannot use (ATO-1399)", () => {
  it("resends a unary completion once without the named tool", async () => {
    const { provider, fetchImpl, bodies, warn } = setup([
      () => json(SCHEMA_500, 500),
      okUnary,
    ]);
    const result = await provider.complete({
      prompt: "hi",
      tools: [GOOD_TOOL, BAD_TOOL],
    });

    expect(result.content).toBe("ok");
    // No blind 5xx retries of the same body before the drop.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(names(bodies[0]!)).toEqual(["os__fs__read", "plugin__records__lookup"]);
    expect(names(bodies[1]!)).toEqual(["os__fs__read"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/plugin\.records\.lookup/);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      tool: "plugin.records.lookup",
      status: 500,
    });
    // ATO-1417: the completion names the tool it went out without, by
    // its registry name, so the chat can say so.
    expect(result.droppedTools).toEqual([
      { name: "plugin.records.lookup", reason: "schema_rejected" },
    ]);
  });

  it("resends a streamed completion once without the named tool", async () => {
    const { provider, fetchImpl, bodies } = setup([
      () => json(SCHEMA_500, 500),
      okStream,
    ]);
    const result = await drain(
      provider.completeStream({ prompt: "hi", tools: [GOOD_TOOL, BAD_TOOL] }),
    );

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(names(bodies[1]!)).toEqual(["os__fs__read"]);
    expect(result.droppedTools).toEqual([
      { name: "plugin.records.lookup", reason: "schema_rejected" },
    ]);
  });

  it("names no dropped tool when every tool went out (ATO-1417)", async () => {
    const unary = setup([okUnary]);
    const plain = await unary.provider.complete({
      prompt: "hi",
      tools: [GOOD_TOOL, BAD_TOOL],
    });
    expect(plain.droppedTools).toBeUndefined();
    const streamed = setup([okStream]);
    const live = await drain(
      streamed.provider.completeStream({
        prompt: "hi",
        tools: [GOOD_TOOL, BAD_TOOL],
      }),
    );
    expect(live.droppedTools).toBeUndefined();
  });

  it("surfaces the original error when no single tool matches", async () => {
    const { provider, fetchImpl, warn } = setup([
      () => json(SCHEMA_500, 500),
      okUnary,
    ]);
    const err = await provider
      .complete({ prompt: "hi", tools: [GOOD_TOOL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as Error).message).toMatch(/JSON schema error/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    // Named for what it is, not as retried "server trouble".
    expect(humanizeOpenAiHttpError(err as OpenAiHttpError)).toMatch(
      /could not use the JSON schema/,
    );
  });

  it("throws the original schema error when the resend fails differently", async () => {
    const other400 = () => json('{"error":{"message":"invalid max_tokens"}}', 400);
    for (const run of [
      (p: OpenAiProvider) =>
        p.complete({ prompt: "hi", tools: [GOOD_TOOL, BAD_TOOL] }),
      (p: OpenAiProvider) =>
        drain(p.completeStream({ prompt: "hi", tools: [GOOD_TOOL, BAD_TOOL] })),
    ]) {
      const { provider, fetchImpl } = setup([
        () => json(SCHEMA_500, 500),
        other400,
      ]);
      await expect(run(provider)).rejects.toThrow(/JSON schema error/);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("drops at most one tool per completion", async () => {
    const { provider, fetchImpl } = setup([() => json(SCHEMA_500, 500)]);
    await expect(
      drain(
        provider.completeStream({
          prompt: "hi",
          tools: [GOOD_TOOL, BAD_TOOL],
        }),
      ),
    ).rejects.toThrow(/JSON schema error/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends a boolean subschema as an object, so the first send succeeds", async () => {
    const { provider, fetchImpl, bodies } = setup([okUnary]);
    await provider.complete({
      prompt: "hi",
      tools: [
        {
          type: "function",
          function: {
            name: "plugin__records__lookup",
            parameters: {
              type: "object",
              properties: { evidence: true },
            },
          },
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((bodies[0]!.tools as any[])[0].function.parameters).toEqual({
      type: "object",
      properties: { evidence: {} },
    });
  });
});

describe("OpenAiProvider — remember a refused tool for the session (ATO-1443)", () => {
  it("leaves the refused tool out of the session's next streamed step from the start", async () => {
    const { provider, fetchImpl, bodies } = setup([
      () => json(SCHEMA_500, 500),
      okStream,
      okStream,
    ]);
    const step = { prompt: "hi", sessionId: "s1", tools: [GOOD_TOOL, BAD_TOOL] };
    await drain(provider.completeStream(step));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const next = await drain(provider.completeStream(step));
    // One request, not a refusal and a resend.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(names(bodies[2]!)).toEqual(["os__fs__read"]);
    // Still named, so the chat can say the tool is off.
    expect(next.droppedTools).toEqual([
      { name: "plugin.records.lookup", reason: "schema_rejected" },
    ]);
  });

  it("remembers across unary and streamed calls of the same session", async () => {
    const { provider, fetchImpl, bodies } = setup([
      () => json(SCHEMA_500, 500),
      okUnary,
      okUnary,
    ]);
    const step = { prompt: "hi", sessionId: "s1", tools: [GOOD_TOOL, BAD_TOOL] };
    await provider.complete(step);
    const next = await provider.complete(step);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(names(bodies[2]!)).toEqual(["os__fs__read"]);
    expect(next.droppedTools).toEqual([
      { name: "plugin.records.lookup", reason: "schema_rejected" },
    ]);
  });

  it("does not carry the refusal into another session", async () => {
    const { provider, bodies } = setup([
      () => json(SCHEMA_500, 500),
      okStream,
      okStream,
    ]);
    await drain(
      provider.completeStream({ prompt: "hi", sessionId: "s1", tools: [GOOD_TOOL, BAD_TOOL] }),
    );
    const other = await drain(
      provider.completeStream({ prompt: "hi", sessionId: "s2", tools: [GOOD_TOOL, BAD_TOOL] }),
    );
    expect(names(bodies[2]!)).toEqual(["os__fs__read", "plugin__records__lookup"]);
    expect(other.droppedTools).toBeUndefined();
  });

  it("tries the tool again once its schema changed", async () => {
    const { provider, bodies } = setup([
      () => json(SCHEMA_500, 500),
      okStream,
      okStream,
    ]);
    await drain(
      provider.completeStream({ prompt: "hi", sessionId: "s1", tools: [GOOD_TOOL, BAD_TOOL] }),
    );
    const fixed = {
      type: "function",
      function: {
        name: "plugin__records__lookup",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      },
    };
    await drain(
      provider.completeStream({ prompt: "hi", sessionId: "s1", tools: [GOOD_TOOL, fixed] }),
    );
    expect(names(bodies[2]!)).toEqual(["os__fs__read", "plugin__records__lookup"]);
  });
});
