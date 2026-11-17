import { afterEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/provider/completion-types.js";
import { PLAIN_COMPLETE_MAX_TOKENS_CAP, PLAIN_COMPLETE_PARTITION } from "../runtime/plain-complete.js";
import { startTestHarness, type Harness } from "./test-harness.js";

function result(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

async function post(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/complete", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("answers one plain request without creating a session", async () => {
    const calls: Array<Record<string, unknown>> = [];
    harness = await startTestHarness({
      llamaComplete: async (params) => {
        calls.push(params as unknown as Record<string, unknown>);
        return result("A fluffy orange cat on a windowsill, soft morning light.");
      },
    });
    const before = harness.runtime.sessionStore.listRecent(100).length;

    const { status, json } = await post(harness.baseUrl, {
      prompt: "cat",
      system: "Rewrite image prompts.",
      max_tokens: 1_000_000,
    });

    expect(status).toBe(200);
    expect(json.text).toBe("A fluffy orange cat on a windowsill, soft morning light.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(PLAIN_COMPLETE_PARTITION);
    expect(calls[0]?.maxTokens).toBe(PLAIN_COMPLETE_MAX_TOKENS_CAP);
    expect(calls[0]?.tools).toBeUndefined();
    expect(harness.runtime.sessionStore.listRecent(100).length).toBe(before);
  });

  it("refuses a bad body before any model call", async () => {
    let called = 0;
    harness = await startTestHarness({
      llamaComplete: async () => {
        called += 1;
        return result("x");
      },
    });
    expect((await post(harness.baseUrl, {})).status).toBe(400);
    expect((await post(harness.baseUrl, { prompt: "  " })).status).toBe(400);
    expect((await post(harness.baseUrl, { prompt: "hi", max_tokens: -1 })).status).toBe(400);
    expect((await post(harness.baseUrl, { prompt: "hi", system: 5 })).status).toBe(400);
    expect((await post(harness.baseUrl, "[1,2]")).status).toBe(400);
    expect((await post(harness.baseUrl, "{not json")).status).toBe(400);
    expect(called).toBe(0);
  });

  it("answers 502 when the model fails or answers nothing", async () => {
    harness = await startTestHarness({
      llamaComplete: async () => result("   "),
    });
    const { status, json } = await post(harness.baseUrl, { prompt: "hi" });
    expect(status).toBe(502);
    expect(json.error).toBeDefined();
  });

  it("requires the same bearer key as the other /api routes", async () => {
    harness = await startTestHarness({
      apiKey: "secret-key",
      llamaComplete: async () => result("ok"),
    });
    expect((await post(harness.baseUrl, { prompt: "hi" })).status).toBe(401);
    const authed = await post(harness.baseUrl, { prompt: "hi" }, { authorization: "Bearer secret-key" });
    expect(authed.status).toBe(200);
    expect(authed.json.text).toBe("ok");
  });
});
