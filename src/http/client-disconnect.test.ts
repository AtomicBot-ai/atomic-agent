import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { COMPLETION_ID_HEADER } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * A client that gives up on `POST /v1/chat/completions` must end the
 * turn it started. The desktop's Stop does exactly this — it aborts the
 * fetch — and for a while the agent kept the turn running anyway: it
 * listened for the disconnect on the request, whose `close` event Node
 * had already emitted once the body was read. The model kept
 * generating and the session kept accepting steers for a turn nobody
 * was reading.
 */

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

/** A model call that holds until its signal aborts (or `holdMs` passes). */
function hangingModel(holdMs = 10_000) {
  const state = { entered: 0, aborted: 0, finished: 0 };
  const llamaComplete = async (params: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CompletionResult> => {
    if (params.sessionId.startsWith("reflection:")) return reply("nope");
    state.entered += 1;
    const signal = params.signal;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, holdMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal?.aborted) {
      state.aborted += 1;
      throw signal.reason ?? new DOMException("aborted", "AbortError");
    }
    state.finished += 1;
    return reply("done");
  };
  return { state, llamaComplete };
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

async function steerStatus(baseUrl: string, sessionId: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "still there?" }),
  });
  await res.body?.cancel();
  return res.status;
}

function chatInit(
  sessionId: string,
  stream: boolean,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream,
      session_id: sessionId,
      messages: [{ role: "user", content: "write a long story" }],
    }),
    signal,
  };
}

describe("POST /v1/chat/completions when the client disconnects", () => {
  let harness: Harness;
  let model: ReturnType<typeof hangingModel>;

  beforeEach(async () => {
    model = hangingModel();
    harness = await startTestHarness({ llamaComplete: model.llamaComplete });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("ends a streamed turn when the client drops the stream", async () => {
    const client = new AbortController();
    const res = await fetch(
      `${harness.baseUrl}/v1/chat/completions`,
      chatInit("disconnect-stream", true, client.signal),
    );
    expect(res.status).toBe(200);
    const completionId = res.headers.get(COMPLETION_ID_HEADER)!;
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    // The turn is live: a steer lands and the completion is cancellable.
    expect(await steerStatus(harness.baseUrl, "disconnect-stream")).toBe(200);
    expect(harness.completionRegistry.has(completionId)).toBe(true);

    client.abort();

    expect(await waitFor(() => model.state.aborted === 1, 2_000)).toBe(true);
    expect(
      await waitFor(() => !harness.completionRegistry.has(completionId), 2_000),
    ).toBe(true);
    expect(await steerStatus(harness.baseUrl, "disconnect-stream")).toBe(409);
    expect(model.state.finished).toBe(0);
  });

  it("ends a non-streamed turn when the client stops waiting", async () => {
    const client = new AbortController();
    const pending = fetch(
      `${harness.baseUrl}/v1/chat/completions`,
      chatInit("disconnect-sync", false, client.signal),
    ).catch((err: unknown) => err);
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    expect(await steerStatus(harness.baseUrl, "disconnect-sync")).toBe(200);

    client.abort();
    await pending;

    expect(await waitFor(() => model.state.aborted === 1, 2_000)).toBe(true);
    expect(await steerStatus(harness.baseUrl, "disconnect-sync")).toBe(409);
    expect(model.state.finished).toBe(0);
  });
});

describe("POST /v1/chat/completions when the client stays", () => {
  it("does not abort a turn whose response was delivered in full", async () => {
    const model = hangingModel(50);
    const harness = await startTestHarness({
      llamaComplete: model.llamaComplete,
    });
    try {
      const res = await fetch(
        `${harness.baseUrl}/v1/chat/completions`,
        chatInit("stays", true, new AbortController().signal),
      );
      const body = await res.text();
      expect(body).toContain("data: [DONE]");
      expect(model.state.finished).toBe(1);
      expect(model.state.aborted).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});
