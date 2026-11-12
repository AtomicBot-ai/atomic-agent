import { describe, expect, it, vi } from "vitest";

import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
} from "../completion-types.js";
import { JSON_SCHEMA_TOOLS_FORMAT_NAME } from "./json-schema-tools.js";
import { MALFORMED_STRIKES } from "./json-schema-tool-mode.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * The provider seam of ATO-642: an external engine's client keeps native
 * tools until native calls come back malformed, then sends tool calls
 * through a JSON reply, reads that reply back into `toolCalls`, and goes
 * back to native tools if the engine refuses `response_format`.
 */

const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "function",
    function: {
      name: "os__fs__read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
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

const turn: CompletionRequest = {
  prompt: "### respond\nRespond now.",
  tools: TOOLS,
  toolChoice: "auto",
  sessionId: "s1",
};

const LEAKED = '[TOOL_CALLS]os__fs__read{"path":"a.txt"}';
const CALL_JSON = '{"calls":[{"name":"os__fs__read","arguments":{"path":"a.txt"}}]}';

type Reply = () => Response;

const json =
  (content: string): Reply =>
  () =>
    new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const sse =
  (parts: Array<{ content?: string; reasoning?: string }>): Reply =>
  () =>
    new Response(
      parts
        .map((p) =>
          frame({
            model: "m",
            choices: [
              {
                index: 0,
                delta: {
                  ...(p.content !== undefined ? { content: p.content } : {}),
                  ...(p.reasoning !== undefined
                    ? { reasoning_content: p.reasoning }
                    : {}),
                },
                finish_reason: null,
              },
            ],
          }),
        )
        .join("") +
        frame({
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }) +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

const refusal: Reply = () =>
  new Response(
    JSON.stringify({
      error: { message: "response_format type json_schema is not supported" },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

/** Scripted fetch; a request beyond the script answers 418 (not retried). */
function scriptedFetch(replies: Reply[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = replies.shift();
    return next ? next() : new Response("unexpected extra request", { status: 418 });
  });
  return { fetchImpl: impl as unknown as typeof fetch, bodies };
}

let seq = 0;
function makeProvider(
  fetchImpl: typeof fetch,
  opts: { fallback?: boolean } = {},
) {
  const warn = vi.fn();
  const provider = new OpenAiProvider({
    // A fresh id per provider: the mode record is process-wide.
    id: `ollama-json-${++seq}`,
    providerKind: "openai-compatible",
    baseUrl: "http://localhost:11434",
    apiKey: "",
    defaultChatModel: "mistral-small",
    fetchImpl,
    jsonSchemaToolFallback: opts.fallback ?? true,
    logger: { warn },
  });
  return { provider, warn };
}

async function drain(
  gen: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<{ chunks: StreamChunk[]; result: CompletionResult }> {
  const chunks: StreamChunk[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

describe("OpenAiProvider — JSON-reply tool calls on an external engine", () => {
  it("stays native while native calls work", async () => {
    const { fetchImpl, bodies } = scriptedFetch([json("Hello."), json("Hi again.")]);
    const { provider } = makeProvider(fetchImpl);
    await provider.complete(turn);
    await provider.complete(turn);
    for (const body of bodies) {
      expect(body.tools).toBeDefined();
      expect(body.response_format).toBeUndefined();
    }
  });

  it("switches after malformed native replies and reads the JSON reply into toolCalls", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(json(CALL_JSON));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider, warn } = makeProvider(fetchImpl);

    for (let i = 0; i < MALFORMED_STRIKES; i += 1) {
      // The malformed reply itself still goes up unchanged; the step's
      // own repair handles it.
      expect((await provider.complete(turn)).content).toBe(LEAKED);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("JSON reply");

    const result = await provider.complete(turn);
    const body = bodies.at(-1)!;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: JSON_SCHEMA_TOOLS_FORMAT_NAME },
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("### reply-format");
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([
      {
        id: "json_schema_call_0",
        type: "function",
        function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' },
      },
    ]);
  });

  it("never switches a client that is not an external engine", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES + 1; i += 1) replies.push(json(LEAKED));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider } = makeProvider(fetchImpl, { fallback: false });
    for (let i = 0; i < MALFORMED_STRIKES + 1; i += 1) await provider.complete(turn);
    expect(bodies.every((body) => body.tools !== undefined)).toBe(true);
  });

  it("leaves a request without tools alone in JSON-reply mode", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(json("summary text"));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider } = makeProvider(fetchImpl);
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) await provider.complete(turn);
    const result = await provider.complete({ prompt: "summarise" });
    expect(bodies.at(-1)!.response_format).toBeUndefined();
    expect(result.content).toBe("summary text");
  });

  it("streams: holds the JSON back, keeps reasoning live, and yields the answer once", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(
      sse([
        { reasoning: "thinking" },
        { content: '{"calls":[{"answer":' },
        { content: '"All done."}]}' },
      ]),
    );
    const { fetchImpl } = scriptedFetch(replies);
    const { provider } = makeProvider(fetchImpl);
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) await provider.complete(turn);

    const { chunks, result } = await drain(provider.completeStream(turn));
    expect(chunks.map((c) => c.delta).join("")).toBe("All done.");
    expect(chunks.map((c) => c.reasoningDelta).join("")).toBe("thinking");
    expect(chunks.some((c) => c.delta.includes("{"))).toBe(false);
    expect(result.content).toBe("All done.");
    expect(result.toolCalls ?? []).toHaveLength(0);
  });

  it("streams: a JSON call comes back as toolCalls with no text yielded", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(sse([{ content: CALL_JSON }]));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider } = makeProvider(fetchImpl);
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) await provider.complete(turn);

    const { chunks, result } = await drain(provider.completeStream(turn));
    expect(bodies.at(-1)!.stream).toBe(true);
    expect(bodies.at(-1)!.response_format).toBeDefined();
    expect(chunks.map((c) => c.delta).join("")).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls?.[0]?.function.name).toBe("os__fs__read");
  });

  it("goes back to native tools for good when the engine refuses response_format", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(refusal, json("native answer"), json("still native"));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider, warn } = makeProvider(fetchImpl);
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) await provider.complete(turn);

    const result = await provider.complete(turn);
    expect(result.content).toBe("native answer");
    const [refused, resent] = bodies.slice(-2);
    expect(refused!.response_format).toBeDefined();
    expect(resent!.tools).toBeDefined();
    expect(resent!.response_format).toBeUndefined();
    expect(String(warn.mock.calls.at(-1)![0])).toContain("refused response_format");

    await provider.complete(turn);
    expect(bodies.at(-1)!.tools).toBeDefined();
  });

  it("streams: a refused response_format is resent natively before any output", async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) replies.push(json(LEAKED));
    replies.push(refusal, sse([{ content: "native text" }]));
    const { fetchImpl, bodies } = scriptedFetch(replies);
    const { provider } = makeProvider(fetchImpl);
    for (let i = 0; i < MALFORMED_STRIKES; i += 1) await provider.complete(turn);

    const { chunks, result } = await drain(provider.completeStream(turn));
    expect(bodies.at(-1)!.tools).toBeDefined();
    expect(chunks.map((c) => c.delta).join("")).toBe("native text");
    expect(result.content).toBe("native text");
  });
});
