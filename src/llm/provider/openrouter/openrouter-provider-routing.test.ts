import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../completion-types.js";
import { buildOpenAiChatBody } from "../openai/openai-build-body.js";
import {
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./openrouter-provider.js";

/**
 * `providerPreferences` on the wire. It used to be parsed, validated and
 * then dropped: an operator's `order` / `allow_fallbacks: false` never
 * left the process, and OpenRouter kept routing wherever it liked.
 * Asserted on the serialised request body, because that is the only
 * place the omission was ever visible.
 */

const MODEL = "z-ai/glm-5.3-flash";
const PREFERENCES = { order: ["z-ai"], allow_fallbacks: false };

type Capture = { bodies: Record<string, unknown>[]; fetchImpl: typeof fetch };

function capture(reply: () => Response): Capture {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply();
  });
  return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const unaryReply = () =>
  new Response(
    JSON.stringify({
      model: MODEL,
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const streamReply = () =>
  new Response(
    [
      { model: MODEL, choices: [{ delta: { content: "ok" } }] },
      { model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

function openRouter(
  fetchImpl: typeof fetch,
  extra: Partial<OpenRouterProviderOptions> = {},
): OpenRouterProvider {
  return new OpenRouterProvider({
    id: "openrouter",
    apiKey: "test-key",
    defaultChatModel: MODEL,
    fetchImpl,
    requestTimeoutMs: 5000,
    ...extra,
  });
}

async function drain(
  stream: AsyncGenerator<unknown, unknown, void>,
): Promise<void> {
  for (;;) if ((await stream.next()).done) return;
}

const request: CompletionRequest = { prompt: "hi", maxTokens: 16 };

describe("OpenRouterProvider — providerPreferences", () => {
  it("sends them as `provider` on a unary completion", async () => {
    const { bodies, fetchImpl } = capture(unaryReply);
    await openRouter(fetchImpl, { providerPreferences: PREFERENCES }).complete(
      request,
    );
    expect(bodies[0]?.provider).toEqual(PREFERENCES);
  });

  it("sends them as `provider` on a streamed completion", async () => {
    const { bodies, fetchImpl } = capture(streamReply);
    const provider = openRouter(fetchImpl, {
      providerPreferences: PREFERENCES,
    });
    await drain(provider.completeStream(request));
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[0]?.provider).toEqual(PREFERENCES);
  });

  it("sends them on a structured-output sub-call too", async () => {
    // The reported case: a `response_format` sub-call that the pinned
    // host cannot serve kept succeeding, because it was routed elsewhere.
    const { bodies, fetchImpl } = capture(unaryReply);
    await openRouter(fetchImpl, { providerPreferences: PREFERENCES }).complete({
      prompt: "rewrite",
      maxTokens: 64,
      responseFormat: { name: "rewrite", schema: { type: "object" } },
    });
    expect(bodies[0]?.response_format).toBeDefined();
    expect(bodies[0]?.provider).toEqual(PREFERENCES);
  });

  it("sends them on a vision describe call", async () => {
    const { bodies, fetchImpl } = capture(unaryReply);
    await openRouter(fetchImpl, {
      providerPreferences: PREFERENCES,
    }).describeImage({
      prompt: "describe",
      images: [{ id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" }],
    });
    expect(bodies[0]?.provider).toEqual(PREFERENCES);
  });

  it("lets an explicit extraBody.provider win, unary and streamed", async () => {
    const override = { only: ["anthropic"] };
    const options = {
      providerPreferences: PREFERENCES,
      extraBody: { provider: override },
    };
    const unary = capture(unaryReply);
    await openRouter(unary.fetchImpl, options).complete(request);
    const streamed = capture(streamReply);
    await drain(openRouter(streamed.fetchImpl, options).completeStream(request));
    expect(unary.bodies[0]?.provider).toEqual(override);
    expect(streamed.bodies[0]?.provider).toEqual(override);
  });

  it("leaves every body exactly as before when none are configured", async () => {
    const unary = capture(unaryReply);
    const streamed = capture(streamReply);
    const vision = capture(unaryReply);
    await openRouter(unary.fetchImpl).complete(request);
    await drain(openRouter(streamed.fetchImpl).completeStream(request));
    await openRouter(vision.fetchImpl).describeImage({
      prompt: "describe",
      images: [{ id: 1, bytes: new Uint8Array([1]), mimeType: "image/png" }],
    });
    expect(unary.bodies[0]).not.toHaveProperty("provider");
    expect(streamed.bodies[0]).not.toHaveProperty("provider");
    // Byte-identical to the builder called with its pre-existing arity.
    expect(JSON.stringify(unary.bodies[0])).toBe(
      JSON.stringify(buildOpenAiChatBody(request, MODEL, false)),
    );
    expect(JSON.stringify(streamed.bodies[0])).toBe(
      JSON.stringify(buildOpenAiChatBody(request, MODEL, true)),
    );
    expect(vision.bodies[0]).not.toHaveProperty("provider");
  });
});

describe("OpenRouterProvider — cache-capable routes for Google models", () => {
  const GOOGLE = "google/gemini-3.8-flash";
  const CACHE_ROUTES = {
    order: ["Google AI Studio", "Google"],
    allow_fallbacks: true,
  };

  it("pins a Google model to its caching routes by default, unary and streamed", async () => {
    const { bodies, fetchImpl } = capture(unaryReply);
    const provider = openRouter(fetchImpl, { defaultChatModel: GOOGLE });
    await provider.complete(request);
    expect(bodies[0]?.provider).toEqual(CACHE_ROUTES);

    const streamed = capture(streamReply);
    await drain(
      openRouter(streamed.fetchImpl, { defaultChatModel: GOOGLE }).completeStream(request),
    );
    expect(streamed.bodies[0]?.provider).toEqual(CACHE_ROUTES);
  });

  it("lets the operator's own providerPreferences win", async () => {
    const { bodies, fetchImpl } = capture(unaryReply);
    await openRouter(fetchImpl, {
      defaultChatModel: GOOGLE,
      providerPreferences: PREFERENCES,
    }).complete(request);
    expect(bodies[0]?.provider).toEqual(PREFERENCES);
  });

  it("sends nothing when preferCacheRoutes is off, or the model is not Google's", async () => {
    const off = capture(unaryReply);
    await openRouter(off.fetchImpl, {
      defaultChatModel: GOOGLE,
      preferCacheRoutes: false,
    }).complete(request);
    expect(off.bodies[0]).not.toHaveProperty("provider");

    const other = capture(unaryReply);
    await openRouter(other.fetchImpl).complete(request);
    expect(other.bodies[0]).not.toHaveProperty("provider");
  });
});
