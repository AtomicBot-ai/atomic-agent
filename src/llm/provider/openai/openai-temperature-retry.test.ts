import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompletionResult,
  StreamChunk,
} from "../completion-types.js";
import { forgetLearnedModelParams } from "./model-params.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * ATO-1217: a 400 that names the only temperature a model accepts is
 * answered with one resend at that value, and the value is kept for the
 * model. Any other 400 fails as before.
 */

const MODEL = "vendor/strict-model";

const ONLY_ONE_400 = JSON.stringify({
  error: {
    message: "invalid temperature: only 1 is allowed for this model",
    type: "invalid_request_error",
  },
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

/** Answers in order, recording each body sent. */
function scripted(responses: ReadonlyArray<() => Response>) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1];
    return next!();
  });
  return { fetchImpl, bodies };
}

function provider(fetchImpl: unknown): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: MODEL,
    fetchImpl: fetchImpl as typeof fetch,
  });
}

async function drain(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<CompletionResult> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
  }
}

afterEach(() => {
  forgetLearnedModelParams();
});

describe("OpenAiProvider — named-temperature retry (ATO-1217)", () => {
  it("resends a unary completion once at the named temperature", async () => {
    const { fetchImpl, bodies } = scripted([
      () => json(ONLY_ONE_400, 400),
      okUnary,
    ]);
    const result = await provider(fetchImpl).complete({ prompt: "hi" });

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.temperature).toBe(0.2);
    expect(bodies[1]!.temperature).toBe(1);
  });

  it("resends a streamed completion once and keeps the value for the model", async () => {
    const { fetchImpl, bodies } = scripted([
      () => json(ONLY_ONE_400, 400),
      okStream,
      okStream,
    ]);
    const p = provider(fetchImpl);
    const result = await drain(p.completeStream({ prompt: "hi" }));

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]!.temperature).toBe(1);

    // The next turn goes out right the first time.
    await drain(p.completeStream({ prompt: "again" }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodies[2]!.temperature).toBe(1);
  });

  it("does not resend on any other 400", async () => {
    const { fetchImpl } = scripted([
      () => json('{"error":{"message":"invalid max_tokens"}}', 400),
      okUnary,
    ]);
    await expect(provider(fetchImpl).complete({ prompt: "hi" })).rejects.toThrow(
      /400/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resends only once when the service keeps refusing", async () => {
    const { fetchImpl } = scripted([() => json(ONLY_ONE_400, 400)]);
    await expect(provider(fetchImpl).complete({ prompt: "hi" })).rejects.toThrow(
      /400/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("OpenAiProvider — no-temperature retry (ATO-1397)", () => {
  const DEPRECATED_400 = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "`temperature` is deprecated for this model.",
    },
  });

  it("resends once without temperature and keeps that for the model", async () => {
    const { fetchImpl, bodies } = scripted([
      () => json(DEPRECATED_400, 400),
      okStream,
      okStream,
    ]);
    const p = provider(fetchImpl);
    const result = await drain(p.completeStream({ prompt: "hi" }));

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.temperature).toBe(0.2);
    expect("temperature" in bodies[1]!).toBe(false);

    await drain(p.completeStream({ prompt: "again" }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect("temperature" in bodies[2]!).toBe(false);
  });

  it("drops an operator's temperature too once the service refused it", async () => {
    const { fetchImpl, bodies } = scripted([
      () => json(DEPRECATED_400, 400),
      okUnary,
    ]);
    const p = new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: MODEL,
      extraBody: { temperature: 0.7 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.complete({ prompt: "hi" });
    expect(bodies[0]!.temperature).toBe(0.7);
    expect("temperature" in bodies[1]!).toBe(false);
  });
});
