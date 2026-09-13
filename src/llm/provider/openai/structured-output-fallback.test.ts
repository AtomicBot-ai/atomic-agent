import { describe, expect, it, vi } from "vitest";

import type {
  CompletionRequest,
  ResponseFormatJsonSchema,
} from "../completion-types.js";
import { ensureJsonMention } from "./ensure-json-mention.js";
import { OpenAiHttpError } from "./openai-http.js";
import { OpenAiProvider } from "./openai-provider.js";
import { OPENROUTER_PARAMETER_REFUSAL_BODY } from "./structured-output-refusal.fixture.js";

const responseFormat: ResponseFormatJsonSchema = {
  name: "query_rewriter",
  schema: {
    type: "object",
    properties: { rewritten_query: { type: "string" } },
    required: ["rewritten_query"],
    additionalProperties: false,
  },
};

const ENVELOPE = "<rewritten_query>deploy the kastel app</rewritten_query>";

type Reply = () => Response;

const ok =
  (content: string): Reply =>
  () =>
    new Response(
      JSON.stringify({
        model: "z-ai/glm-5.3-flash",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

const status =
  (code: number, body: string): Reply =>
  () =>
    new Response(body, { status: code });

const refusal = status(404, OPENROUTER_PARAMETER_REFUSAL_BODY);

/**
 * Scripted fetch that records every request body. A request beyond the
 * script answers 418 — non-retryable, so an unexpected send fails the
 * test loudly instead of being absorbed by the retry budget.
 */
function scriptedFetch(replies: Reply[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = replies.shift();
    return next ? next() : new Response("unexpected extra request", { status: 418 });
  });
  return { fetchImpl: impl as unknown as typeof fetch, bodies, replies };
}

let seq = 0;
function makeProvider(
  fetchImpl: typeof fetch,
  opts: { id?: string; model?: string } = {},
) {
  const warn = vi.fn();
  const provider = new OpenAiProvider({
    id: opts.id ?? `openrouter-${++seq}`,
    baseUrl: "https://openrouter.example",
    apiKey: "k",
    defaultChatModel: opts.model ?? "z-ai/glm-5.3-flash",
    fetchImpl,
    logger: { warn },
  });
  return { provider, warn };
}

const subcall: CompletionRequest = { prompt: "rewrite", maxTokens: 256, responseFormat };

describe("OpenAiProvider.complete — structured-output refusal fallback", () => {
  it("retries once without response_format and returns that answer", async () => {
    const net = scriptedFetch([refusal, ok(ENVELOPE)]);
    const { provider, warn } = makeProvider(net.fetchImpl);

    const result = await provider.complete(subcall);

    expect(result.content).toBe(ENVELOPE);
    expect(net.bodies).toHaveLength(2);
    expect(net.bodies[0]).toHaveProperty("response_format.type", "json_schema");
    expect(net.bodies[1]).not.toHaveProperty("response_format");
    // Only the field is dropped: the retry is otherwise the same request —
    // except the JSON mention `ensureJsonMention` adds only to a body that
    // carries `response_format`, so the retry sends the caller's prompt.
    const { response_format: _sent, ...firstWithout } = net.bodies[0]!;
    expect(net.bodies[0]).toHaveProperty(
      "messages.0.content",
      ensureJsonMention(subcall.prompt),
    );
    expect(net.bodies[1]).toEqual({
      ...firstWithout,
      messages: [{ role: "user", content: subcall.prompt }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(provider.id);
    expect(warn.mock.calls[0]![0]).toContain("does not support structured outputs");
  });

  it("remembers the refusal: the next sub-call skips response_format with no failed round trip", async () => {
    const net = scriptedFetch([refusal, ok(ENVELOPE), ok(ENVELOPE)]);
    const { provider, warn } = makeProvider(net.fetchImpl);

    await provider.complete(subcall);
    await provider.complete(subcall);

    expect(net.bodies).toHaveLength(3);
    expect(net.bodies[2]).not.toHaveProperty("response_format");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keys the memory by provider id and model, and outlives the provider instance", async () => {
    const id = `openrouter-${++seq}`;
    const first = scriptedFetch([refusal, ok(ENVELOPE)]);
    await makeProvider(first.fetchImpl, { id }).provider.complete(subcall);

    const rebuilt = scriptedFetch([ok(ENVELOPE)]);
    await makeProvider(rebuilt.fetchImpl, { id }).provider.complete(subcall);
    expect(rebuilt.bodies[0]).not.toHaveProperty("response_format");

    const otherProvider = scriptedFetch([ok(ENVELOPE)]);
    await makeProvider(otherProvider.fetchImpl).provider.complete(subcall);
    expect(otherProvider.bodies[0]).toHaveProperty("response_format");

    const otherModel = scriptedFetch([ok(ENVELOPE)]);
    await makeProvider(otherModel.fetchImpl, {
      id,
      model: "openai/gpt-5.4-mini",
    }).provider.complete(subcall);
    expect(otherModel.bodies[0]).toHaveProperty("response_format");
  });

  it.each([
    ["invalid key", "API key not valid. Please pass a valid API key."],
    ["context length", "This model's maximum context length is 32768 tokens."],
    [
      "json word",
      "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.",
    ],
  ])("propagates a non-refusal 400 (%s) unchanged, without a retry", async (_label, message) => {
    const body = JSON.stringify({ error: { message } });
    const net = scriptedFetch([status(400, body), ok(ENVELOPE)]);
    const { provider, warn } = makeProvider(net.fetchImpl);

    const err = await provider.complete(subcall).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(400);
    expect((err as OpenAiHttpError).message).toBe(`openai provider 400: ${body}`);
    expect(net.bodies).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("has no retry path for a request without responseFormat", async () => {
    const net = scriptedFetch([refusal, ok(ENVELOPE)]);
    const { provider } = makeProvider(net.fetchImpl);

    await expect(provider.complete({ prompt: "turn" })).rejects.toMatchObject({ status: 404 });
    expect(net.bodies).toHaveLength(1);
  });

  it("has no retry path when tools kept response_format off the wire", async () => {
    const net = scriptedFetch([refusal, ok(ENVELOPE)]);
    const { provider } = makeProvider(net.fetchImpl);
    const tools: NonNullable<CompletionRequest["tools"]> = [
      { type: "function", function: { name: "emit", parameters: { type: "object" } } },
    ];

    await expect(provider.complete({ ...subcall, tools })).rejects.toMatchObject({ status: 404 });
    expect(net.bodies).toHaveLength(1);
    expect(net.bodies[0]).not.toHaveProperty("response_format");
  });

  it("propagates a failed retry's own error and remembers nothing", async () => {
    const other = JSON.stringify({ error: { message: "Provider returned error" } });
    const net = scriptedFetch([refusal, status(400, other), ok(ENVELOPE)]);
    const { provider, warn } = makeProvider(net.fetchImpl);

    await expect(provider.complete(subcall)).rejects.toMatchObject({ status: 400 });
    await provider.complete(subcall);

    expect(net.bodies).toHaveLength(3);
    expect(net.bodies[2]).toHaveProperty("response_format");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves streaming alone: a refusal on completeStream is not retried", async () => {
    const net = scriptedFetch([refusal, ok(ENVELOPE)]);
    const { provider } = makeProvider(net.fetchImpl);

    const stream = provider.completeStream(subcall);
    await expect(stream.next()).rejects.toMatchObject({ status: 404 });
    expect(net.bodies).toHaveLength(1);
  });
});
