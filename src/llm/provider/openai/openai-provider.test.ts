import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import { OpenAiProvider } from "./openai-provider.js";

const tools: NonNullable<CompletionRequest["tools"]> = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
];

function fakeFetch(message: Record<string, unknown>) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "qwen-test",
          choices: [{ message, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

/** SSE-shaped fake for the streaming path: emits `content` as one delta, then done. */
function fakeStreamFetch(content: string) {
  const frame = (obj: Record<string, unknown>) =>
    `data: ${JSON.stringify(obj)}\n\n`;
  const body =
    frame({
      model: "qwen-test",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    }) +
    frame({
      model: "qwen-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }) +
    "data: [DONE]\n\n";
  return vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
}

function provider(
  fetchImpl: typeof fetch,
  taggedToolCompatibility: "qwen" | undefined,
): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "qwen-test",
    fetchImpl,
    taggedToolCompatibility,
  });
}

describe("OpenAiProvider qwen tagged-tool compatibility", () => {
  it("adapts non-streaming responses with request tools only when opted in", async () => {
    const fetchImpl = fakeFetch({
      role: "assistant",
      content:
        "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
    });

    const result = await provider(
      fetchImpl as unknown as typeof fetch,
      "qwen",
    ).complete({ prompt: "read", tools });

    expect(result.content).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toMatchObject([
      {
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"/tmp/a"}' },
      },
    ]);
  });

  it("decodes a reply that is only tagged blocks on the default kind too", async () => {
    // Hermes fine-tunes and Qwen-derived models write `<tool_call>` text
    // over any OpenAI-compatible server, not only the Qwen kind; a reply
    // that is nothing but such blocks is a tool call wherever it came
    // from. Both dialects: Qwen's XML-ish form and the Hermes JSON form.
    for (const tagged of [
      "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
      '<tool_call>{"name": "os.fs.read", "arguments": {"path": "/tmp/a"}}</tool_call>',
    ]) {
      const result = await provider(
        fakeFetch({ role: "assistant", content: tagged }) as unknown as typeof fetch,
        undefined,
      ).complete({ prompt: "read", tools });
      expect(result.content).toBe("");
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toMatchObject([
        {
          type: "function",
          function: { name: "os__fs__read", arguments: '{"path":"/tmp/a"}' },
        },
      ]);
    }
  });

  it("keeps a reply that merely quotes the syntax, and never reads reasoning on the default kind", async () => {
    const quoted =
      "Use this shape:\n<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>";
    const prose = await provider(
      fakeFetch({ role: "assistant", content: quoted }) as unknown as typeof fetch,
      undefined,
    ).complete({ prompt: "read", tools });
    expect(prose.content).toBe(quoted);
    expect(prose.toolCalls).toBeUndefined();
    expect(prose.finishReason).toBe("stop");

    // #105's reasoning-channel fallback is Qwen's: elsewhere the channel
    // is scratch space, and a call thought about is not a call made.
    const thought = await provider(
      fakeFetch({
        role: "assistant",
        content: "",
        reasoning_content:
          "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
      }) as unknown as typeof fetch,
      undefined,
    ).complete({ prompt: "read", tools });
    expect(thought.toolCalls).toBeUndefined();
    expect(thought.reasoningContent).toContain("<tool_call>");
  });

  it("reads reasoning from whichever field the service writes, by default", async () => {
    for (const field of ["reasoning", "reasoning_content", "thinking"]) {
      const result = await provider(
        fakeFetch({
          role: "assistant",
          content: "ok",
          [field]: "because",
        }) as unknown as typeof fetch,
        undefined,
      ).complete({ prompt: "hi" });
      expect(result.reasoningContent).toBe("because");
    }
  });

  it("streams deltas, then adapts the buffered tagged calls (buffer-then-adapt)", async () => {
    const tagged = [
      "<tool_call><function=os.fs.read><parameter=path>/tmp/a</parameter></function></tool_call>",
      "<tool_call><function=os.fs.read><parameter=path>/tmp/b</parameter></function></tool_call>",
    ].join("");
    const fetchImpl = fakeStreamFetch(tagged);
    const stream = provider(
      fetchImpl as unknown as typeof fetch,
      "qwen",
    ).completeStream({ prompt: "read", tools });

    // First yield is the live text delta (raw tagged text), not the final result.
    const first = await stream.next();
    expect(first.done).toBe(false);
    // Drain to the returned CompletionResult.
    let final: Awaited<ReturnType<typeof stream.next>> | undefined;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        final = next;
        break;
      }
    }
    if (!final || !final.done) throw new Error("stream never completed");
    // The buffered final has the tagged text rewritten into tool_calls.
    expect(final.value.toolCalls?.map((call) => call.id)).toEqual([
      "call_qwen_tagged_0",
      "call_qwen_tagged_1",
    ]);
    expect(
      final.value.toolCalls?.map((call) => JSON.parse(call.function.arguments)),
    ).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);
    expect(final.value.content).toBe("");
    expect(final.value.finishReason).toBe("tool_calls");

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      tools,
    });
  });
});

/**
 * The `strictTools` entry flag, end to end through the provider.
 *
 * The transform, the body builder and the config parser each have their
 * own unit coverage; what had none was the wiring between them — the
 * two `buildOpenAiChatBody` call sites that must pass `this.strictTools`
 * and the constructor branch that must wrap the tool-call adapter.
 * Deleting either left every test in the repo green, so the feature
 * could be silently removed by a refactor. These assert the observable
 * ends: the bytes on the wire, and the args a parsed call carries.
 */
describe("OpenAiProvider strictTools wiring", () => {
  function strictProvider(
    fetchImpl: typeof fetch,
    strictTools: boolean | undefined,
  ): OpenAiProvider {
    return new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: "qwen-test",
      fetchImpl,
      ...(strictTools === undefined ? {} : { strictTools }),
    });
  }

  const sentBody = (fetchImpl: ReturnType<typeof fakeFetch>, index = 0) =>
    JSON.parse(
      String((fetchImpl.mock.calls[index]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;

  it("reaches the non-streaming request body", async () => {
    const fetchImpl = fakeFetch({ role: "assistant", content: "ok" });
    await strictProvider(fetchImpl as unknown as typeof fetch, true).complete({
      prompt: "read",
      tools,
    });
    const body = sentBody(fetchImpl);
    const fn = (body.tools as Array<{ function: Record<string, unknown> }>)[0]
      .function;
    expect(fn.strict).toBe(true);
    expect(fn.parameters).toEqual({
      type: "object",
      properties: { path: { type: ["string", "null"] } },
      required: ["path"],
      additionalProperties: false,
    });
    // Strict decoding is only guaranteed with parallel calls off.
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("reaches the streaming request body", async () => {
    const fetchImpl = fakeStreamFetch("ok");
    const stream = strictProvider(
      fetchImpl as unknown as typeof fetch,
      true,
    ).completeStream({ prompt: "read", tools });
    while (!(await stream.next()).done) {
      /* drain */
    }
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    const fn = (body.tools as Array<{ function: Record<string, unknown> }>)[0]
      .function;
    expect(fn.strict).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("leaves the body untouched when the flag is absent or false", async () => {
    for (const flag of [undefined, false] as const) {
      const fetchImpl = fakeFetch({ role: "assistant", content: "ok" });
      await strictProvider(
        fetchImpl as unknown as typeof fetch,
        flag,
      ).complete({ prompt: "read", tools });
      const body = sentBody(fetchImpl);
      expect(body.tools).toEqual(tools);
      expect(body.parallel_tool_calls).toBe(true);
    }
  });

  it("wraps the tool-call adapter so parsed calls lose top-level nulls", () => {
    const call = [
      {
        id: "call_1",
        type: "function" as const,
        function: {
          name: "memory__profile__set",
          arguments: '{"key":"k","value":"v","pinned":null}',
        },
      },
    ];
    const on = strictProvider(fakeFetch({}) as unknown as typeof fetch, true);
    expect(on.toolCallAdapter?.toolCallsToBatch(call).calls[0]?.args).toEqual({
      key: "k",
      value: "v",
    });
    const off = strictProvider(fakeFetch({}) as unknown as typeof fetch, false);
    expect(off.toolCallAdapter?.toolCallsToBatch(call).calls[0]?.args).toEqual({
      key: "k",
      value: "v",
      pinned: null,
    });
  });
});

describe("OpenAiProvider — cached prompt tokens", () => {
  it("reads prompt_tokens_details.cached_tokens on the unary path", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "m",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 5,
              total_tokens: 1005,
              prompt_tokens_details: { cached_tokens: 900 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await provider(fetchImpl as unknown as typeof fetch, undefined).complete({
      prompt: "hi",
    });
    expect(result.usage?.cachedTokens).toBe(900);
    expect(result.cacheHitTokens).toBe(900);
  });

  it("reads it on the streamed path, and leaves it absent when the service says nothing", async () => {
    const frame = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;
    const streamWith = (usage: Record<string, unknown>) =>
      vi.fn(
        async () =>
          new Response(
            frame({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }) +
              frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
              "data: [DONE]\n\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      );
    const drain = async (fetchImpl: typeof fetch) => {
      const stream = provider(fetchImpl, undefined).completeStream({ prompt: "hi" });
      for (;;) {
        const next = await stream.next();
        if (next.done) return next.value;
      }
    };
    const cached = await drain(
      streamWith({
        prompt_tokens: 1000,
        completion_tokens: 5,
        total_tokens: 1005,
        prompt_tokens_details: { cached_tokens: 640 },
      }) as unknown as typeof fetch,
    );
    expect(cached.usage?.cachedTokens).toBe(640);
    expect(cached.cacheHitTokens).toBe(640);

    const silent = await drain(
      streamWith({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 }) as unknown as typeof fetch,
    );
    expect(silent.usage).not.toHaveProperty("cachedTokens");
    expect(silent.cacheHitTokens).toBe(0);
  });
});

describe("OpenAiProvider — message shape on the wire", () => {
  const messages = {
    system: "prefix",
    droppedSummary: null,
    turns: [
      { kind: "user" as const, text: "hi" },
      { kind: "assistant_tool_call" as const, tool: "os.fs.read", args: { path: "a" } },
      { kind: "tool_result" as const, tool: "os.fs.read", status: "ok" as const, body: "A", truncated: false },
    ],
    tail: "tail",
  };
  const okReply = () =>
    new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const okStream = () =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const roleRejection = () =>
    new Response(JSON.stringify({ error: { message: "Unknown role: tool", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  const otherRejection = () =>
    new Response(JSON.stringify({ error: { message: "maximum context length is 8192 tokens, requested 9000" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  function capturing(replies: Array<() => Response>) {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies[Math.min(call, replies.length - 1)]!;
      call += 1;
      return reply();
    });
    return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  const roles = (body: Record<string, unknown> | undefined) =>
    (body?.messages as Array<{ role: string }>).map((m) => m.role);
  const logger = () => ({ warn: vi.fn() });

  function shaped(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {}) {
    return new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: "m",
      fetchImpl,
      ...extra,
    });
  }
  const drain = async (stream: AsyncGenerator<unknown, unknown, void>) => {
    for (;;) if ((await stream.next()).done) return;
  };

  it("sends the native layout by default, unary and streamed", async () => {
    const unary = capturing([okReply]);
    await shaped(unary.fetchImpl).complete({ prompt: "flat", messages, tools, sessionId: "s" });
    expect(roles(unary.bodies[0])).toEqual(["system", "user", "assistant", "tool", "user"]);

    const streamed = capturing([okStream]);
    await drain(shaped(streamed.fetchImpl).completeStream({ prompt: "flat", messages, tools, sessionId: "s" }));
    expect(roles(streamed.bodies[0])).toEqual(["system", "user", "assistant", "tool", "user"]);
  });

  it("sends the flat layout when the entry says so", async () => {
    const { bodies, fetchImpl } = capturing([okReply]);
    await shaped(fetchImpl, { messageShape: "flat" }).complete({ prompt: "flat", messages, tools });
    expect(bodies[0]?.messages).toEqual([{ role: "user", content: "flat" }]);
  });

  it("falls back to flat once on a 400 about roles, logs it, and keeps the session flat", async () => {
    const { bodies, fetchImpl } = capturing([roleRejection, okReply, okReply, okReply]);
    const log = logger();
    const provider = shaped(fetchImpl, { logger: log });
    const result = await provider.complete({ prompt: "flat", messages, tools, sessionId: "s1" });
    expect(result.content).toBe("ok");
    expect(roles(bodies[0])).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(bodies[1]?.messages).toEqual([{ role: "user", content: "flat" }]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/rejected native chat messages/);

    // The same session goes out flat up front; another session is still native.
    await provider.complete({ prompt: "flat", messages, tools, sessionId: "s1" });
    expect(bodies[2]?.messages).toEqual([{ role: "user", content: "flat" }]);
    await provider.complete({ prompt: "flat", messages, tools, sessionId: "s2" });
    expect(roles(bodies[3])).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(bodies).toHaveLength(4);
  });

  it("falls back on the streamed path too, before any chunk exists", async () => {
    const { bodies, fetchImpl } = capturing([roleRejection, okStream]);
    const log = logger();
    const provider = shaped(fetchImpl, { logger: log });
    const stream = provider.completeStream({ prompt: "flat", messages, tools, sessionId: "s" });
    const deltas: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        expect(next.value.content).toBe("ok");
        break;
      }
      deltas.push(next.value.delta);
    }
    expect(deltas.join("")).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual([{ role: "user", content: "flat" }]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("does not resend on a 400 about anything else, nor when already flat", async () => {
    const other = capturing([otherRejection]);
    await expect(
      shaped(other.fetchImpl).complete({ prompt: "flat", messages, tools, sessionId: "s" }),
    ).rejects.toThrow(/maximum context length/);
    expect(other.bodies).toHaveLength(1);

    const flat = capturing([roleRejection]);
    await expect(
      shaped(flat.fetchImpl, { messageShape: "flat" }).complete({ prompt: "flat", messages, tools }),
    ).rejects.toThrow(/Unknown role/);
    expect(flat.bodies).toHaveLength(1);
  });

  it("marks Anthropic breakpoints for a Claude model, and none for another", async () => {
    const claude = capturing([okReply]);
    await shaped(claude.fetchImpl, { defaultChatModel: "anthropic/claude-sonnet-4.5" }).complete({
      prompt: "flat",
      messages,
      tools,
    });
    const sent = claude.bodies[0]?.messages as Array<Record<string, unknown>>;
    expect(sent[0]?.content).toEqual([{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }]);

    const off = capturing([okReply]);
    await shaped(off.fetchImpl, { defaultChatModel: "anthropic/claude-sonnet-4.5", promptCache: "off" }).complete({
      prompt: "flat",
      messages,
      tools,
    });
    expect(JSON.stringify(off.bodies[0])).not.toContain("ephemeral");

    const gpt = capturing([okReply]);
    await shaped(gpt.fetchImpl, { defaultChatModel: "openai/gpt-4.1" }).complete({ prompt: "flat", messages, tools });
    expect(JSON.stringify(gpt.bodies[0])).not.toContain("ephemeral");
  });
});
