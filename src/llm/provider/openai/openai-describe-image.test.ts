import { afterEach, describe, expect, it, vi } from "vitest";

import { describeImageViaOpenAi } from "./openai-describe-image.js";
import { forgetLearnedModelParams } from "./model-params.js";
import type { OpenAiHttpDeps } from "./openai-http.js";

afterEach(() => {
  forgetLearnedModelParams();
});

function recordingDeps(): {
  deps: OpenAiHttpDeps;
  body: () => Record<string, unknown>;
} {
  let sent: Record<string, unknown> = {};
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "a cat" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    deps: {
      baseUrl: "https://api.example.com",
      apiKey: "key",
      extraHeaders: {},
      requestTimeoutMs: 5_000,
      fetchImpl,
      label: "testprov",
    },
    body: () => sent,
  };
}

const REQUEST = {
  prompt: "what is this?",
  images: [{ id: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
};

describe("describeImageViaOpenAi — per-model parameters (ATO-1215)", () => {
  it("sends Kimi K3.1 its one allowed temperature", async () => {
    const { deps, body } = recordingDeps();
    const result = await describeImageViaOpenAi(deps, "moonshotai/kimi-k3.1-pro", REQUEST);
    expect(result.text).toBe("a cat");
    expect(body().temperature).toBe(1);
    expect(body().max_tokens).toBe(4096);
  });

  it("sends gpt-5 no temperature and max_completion_tokens", async () => {
    const { deps, body } = recordingDeps();
    await describeImageViaOpenAi(deps, "gpt-5", REQUEST);
    expect(body()).not.toHaveProperty("temperature");
    expect(body()).not.toHaveProperty("max_tokens");
    expect(body().max_completion_tokens).toBe(4096);
  });

  it("keeps 0.1 and max_tokens for gpt-4o", async () => {
    const { deps, body } = recordingDeps();
    await describeImageViaOpenAi(deps, "gpt-4o", REQUEST);
    expect(body().temperature).toBe(0.1);
    expect(body().max_tokens).toBe(4096);
    expect(body()).not.toHaveProperty("max_completion_tokens");
  });

  it("applies extraBody and model params like a turn, keeping the request's identity", async () => {
    const { deps, body } = recordingDeps();
    await describeImageViaOpenAi(deps, "gpt-4o", REQUEST, "/v1", undefined, {
      extraBody: { top_p: 0.5, model: "other", stream: true },
      modelParams: { top_p: 0.9, temperature: 0.3 },
    });
    expect(body().top_p).toBe(0.9);
    expect(body().temperature).toBe(0.3);
    expect(body().model).toBe("gpt-4o");
    expect(body().stream).toBe(false);
  });
});
