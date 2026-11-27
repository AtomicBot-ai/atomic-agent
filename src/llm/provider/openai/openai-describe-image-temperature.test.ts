import { afterEach, describe, expect, it, vi } from "vitest";

import { describeImageViaOpenAi } from "./openai-describe-image.js";
import { forgetLearnedModelParams } from "./model-params.js";
import type { OpenAiHttpDeps } from "./openai-http.js";

/**
 * #1554: the describe call learns a refused temperature from the 400 and
 * resends once without it, as a turn does, instead of failing the image.
 */

afterEach(() => {
  forgetLearnedModelParams();
});

const DEPRECATED_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "`temperature` is deprecated for this model.",
  },
});

function json(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function ok(): Response {
  return json(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "a cat" } }] }),
    200,
  );
}

function scripted(responses: ReadonlyArray<() => Response>) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1]!;
    return next();
  }) as unknown as typeof fetch;
  const deps: OpenAiHttpDeps = {
    baseUrl: "https://gateway.example.com",
    apiKey: "key",
    extraHeaders: {},
    requestTimeoutMs: 5_000,
    fetchImpl,
    label: "gateway",
  };
  return { deps, bodies, fetchImpl };
}

const REQUEST = {
  prompt: "what is this?",
  images: [{ id: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
};

describe("describeImageViaOpenAi: refused temperature (#1554)", () => {
  it("resends once without temperature for an id the static rule does not know", async () => {
    const { deps, bodies, fetchImpl } = scripted([() => json(DEPRECATED_400, 400), ok]);
    const result = await describeImageViaOpenAi(deps, "gateway/claude-latest", REQUEST);

    expect(result.text).toBe("a cat");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.temperature).toBe(0.1);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("drops an operator's params.temperature on a known Claude id after the 400", async () => {
    const { deps, bodies } = scripted([() => json(DEPRECATED_400, 400), ok]);
    await describeImageViaOpenAi(deps, "claude-opus-5-5", REQUEST, "/v1", undefined, {
      modelParams: { temperature: 0.5 },
    });

    expect(bodies[0]!.temperature).toBe(0.5);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("keeps the learned rule for the next describe call", async () => {
    const { deps, bodies, fetchImpl } = scripted([() => json(DEPRECATED_400, 400), ok, ok]);
    await describeImageViaOpenAi(deps, "gateway/claude-latest", REQUEST);
    await describeImageViaOpenAi(deps, "gateway/claude-latest", REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodies[2]).not.toHaveProperty("temperature");
  });

  it("fails on a second refusal instead of looping", async () => {
    const { deps, fetchImpl } = scripted([() => json(DEPRECATED_400, 400)]);
    await expect(
      describeImageViaOpenAi(deps, "gateway/claude-latest", REQUEST),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not resend a 400 about something else", async () => {
    const { deps, fetchImpl } = scripted([
      () => json('{"error":{"message":"image too large"}}', 400),
    ]);
    await expect(
      describeImageViaOpenAi(deps, "gateway/claude-latest", REQUEST),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
