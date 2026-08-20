import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { deriveChatSessionId } from "./openai-session-id.js";
import {
  EXTENSIONS_HEADER,
  SESSION_ID_HEADER,
} from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Build a one-shot `reply` llama response. Each test uses a fresh
 * scripted generator so multi-turn tests can assert on per-step text.
 */
function scriptedLlama(replies: string[]) {
  const queue = [...replies];
  return async (): Promise<CompletionResult> => {
    const text = queue.shift() ?? "fallback";
    return {
      content: JSON.stringify({ tool: "reply", args: { text } }),
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 4,
        predictedTokens: 2,
      },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    };
  };
}

async function postChat(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/chat/completions (non-stream)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({
      llamaComplete: scriptedLlama(["hi back"]),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("returns 400 when messages are missing", async () => {
    const response = await postChat(harness.baseUrl, { model: "atomic-agent" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/messages/i);
  });

  it("returns the assistant reply as an OpenAI chat.completion", async () => {
    const response = await postChat(harness.baseUrl, {
      model: "atomic-agent",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(SESSION_ID_HEADER.toLowerCase())).toMatch(/^api-/);
    const body = (await response.json()) as {
      object: string;
      choices: Array<{ message: { content: string; role: string } }>;
      session_id: string;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("hi back");
    expect(body.session_id).toMatch(/^api-/);
  });

  it("derives a stable session id from the first user message", async () => {
    const expected = deriveChatSessionId(null, "hello");
    const response = await postChat(harness.baseUrl, {
      model: "atomic-agent",
      messages: [{ role: "user", content: "hello" }],
    });
    const body = (await response.json()) as { session_id: string };
    expect(body.session_id).toBe(expected);
  });

  it("reuses an existing session when X-Atomic-Session-Id is provided", async () => {
    const session = harness.runtime.createSession({
      metadata: { source: "test-preload" },
    });
    const response = await postChat(
      harness.baseUrl,
      {
        model: "atomic-agent",
        messages: [{ role: "user", content: "hello" }],
      },
      { [SESSION_ID_HEADER]: session.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session_id: string };
    expect(body.session_id).toBe(session.id);
    const reloaded = harness.runtime.sessionStore.load(session.id);
    expect(reloaded?.turns.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/chat/completions concurrency contract", () => {
  function instantReply(text: string): CompletionResult {
    return {
      content: JSON.stringify({ tool: "reply", args: { text } }),
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 1,
        predictedTokens: 1,
      },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    };
  }

  it("does not block requests for different sessions on each other", async () => {
    const userEnters: string[] = [];
    const releases = new Map<string, () => void>();
    const llamaComplete = async (params: {
      sessionId: string;
    }): Promise<CompletionResult> => {
      // Reflection calls are background fire-and-forget; resolve them
      // immediately so they cannot pin the mock and skew the test.
      if (params.sessionId.startsWith("reflection:")) {
        return instantReply("nope");
      }
      userEnters.push(params.sessionId);
      await new Promise<void>((resolve) => {
        releases.set(params.sessionId, resolve);
      });
      return instantReply("ok");
    };
    const harness = await startTestHarness({ llamaComplete });
    try {
      const sessionA = harness.runtime.createSession({ metadata: { source: "tA" } });
      const sessionB = harness.runtime.createSession({ metadata: { source: "tB" } });
      const promiseA = postChat(
        harness.baseUrl,
        { messages: [{ role: "user", content: "msg-A" }] },
        { [SESSION_ID_HEADER]: sessionA.id },
      );
      const promiseB = postChat(
        harness.baseUrl,
        { messages: [{ role: "user", content: "msg-B" }] },
        { [SESSION_ID_HEADER]: sessionB.id },
      );

      const deadline = Date.now() + 5_000;
      while (
        (releases.size < 2 || userEnters.length < 2) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(userEnters.length).toBe(2);
      expect(new Set(userEnters)).toEqual(new Set([sessionA.id, sessionB.id]));

      releases.get(sessionA.id)?.();
      releases.get(sessionB.id)?.();

      const [respA, respB] = await Promise.all([promiseA, promiseB]);
      expect(respA.status).toBe(200);
      expect(respB.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("serializes same-session requests strictly FIFO", async () => {
    const userEnters: string[] = [];
    const userLeaves: string[] = [];
    type Releaser = (() => void) | null;
    const releaseRef = { current: null as Releaser };
    let userCallCount = 0;
    const llamaComplete = async (params: {
      sessionId: string;
    }): Promise<CompletionResult> => {
      if (params.sessionId.startsWith("reflection:")) {
        return instantReply("nope");
      }
      userCallCount += 1;
      const tag = `c${userCallCount}`;
      userEnters.push(tag);
      await new Promise<void>((resolve) => {
        releaseRef.current = resolve;
      });
      userLeaves.push(tag);
      return instantReply(tag);
    };
    const harness = await startTestHarness({ llamaComplete });
    try {
      const session = harness.runtime.createSession({ metadata: { source: "fifo" } });
      const promise1 = postChat(
        harness.baseUrl,
        { messages: [{ role: "user", content: "first" }] },
        { [SESSION_ID_HEADER]: session.id },
      );
      const promise2 = postChat(
        harness.baseUrl,
        { messages: [{ role: "user", content: "second" }] },
        { [SESSION_ID_HEADER]: session.id },
      );

      const deadline = Date.now() + 5_000;
      while (userEnters.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(userEnters).toEqual(["c1"]);

      // Give the second request several event-loop turns to "leak" past
      // the per-session lock — it must not.
      await new Promise((r) => setTimeout(r, 50));
      expect(userEnters).toEqual(["c1"]);

      const releaseFirst = releaseRef.current;
      releaseRef.current = null;
      releaseFirst?.();
      const deadline2 = Date.now() + 5_000;
      while (userEnters.length < 2 && Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(userEnters).toEqual(["c1", "c2"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((releaseRef as any).current as Releaser)?.();

      const [resp1, resp2] = await Promise.all([promise1, promise2]);
      expect(resp1.status).toBe(200);
      expect(resp2.status).toBe(200);
      expect(userLeaves).toEqual(["c1", "c2"]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("POST /v1/chat/completions auth", () => {
  it("returns 401 when apiKey is configured and bearer is missing", async () => {
    const harness = await startTestHarness({ apiKey: "secret" });
    try {
      const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_api_key");
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts the request when the bearer matches", async () => {
    const harness = await startTestHarness({
      apiKey: "secret",
      llamaComplete: scriptedLlama(["ok"]),
    });
    try {
      const response = await postChat(
        harness.baseUrl,
        { messages: [{ role: "user", content: "hi" }] },
        { authorization: "Bearer secret" },
      );
      expect(response.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("POST /v1/chat/completions (streaming)", () => {
  function scriptedToolThenReply() {
    const content = [
      JSON.stringify({ tool: "browser.read_aria", args: {} }),
      JSON.stringify({ tool: "reply", args: { text: "after one tool" } }),
    ];
    const queue = [...content];
    return async () => ({
      content: queue.shift() ?? "{}",
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 1,
        predictedTokens: 1,
      },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    });
  }

  it("emits tool_progress events then a content chunk then [DONE] when extensions opt-in", async () => {
    const harness = await startTestHarness({
      llamaComplete: scriptedToolThenReply(),
    });
    try {
      const response = await postChat(
        harness.baseUrl,
        {
          model: "atomic-agent",
          stream: true,
          messages: [{ role: "user", content: "inspect the page" }],
        },
        { [EXTENSIONS_HEADER]: "1" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/event-stream/);
      const text = await readAllText(response);
      expect(text).toMatch(/event: session_id\n/);
      expect(text).toMatch(/event: tool_progress\n/);
      expect(text).toMatch(/"tool":"browser\.read_aria"/);
      expect(text).toMatch(/"content":"after one tool"/);
      expect(text).toMatch(/event: usage\n/);
      expect(text).toMatch(/data: \[DONE\]/);
    } finally {
      await harness.cleanup();
    }
  });

  it("omits atomic-agent SSE extensions by default so OpenAI clients validate cleanly", async () => {
    const harness = await startTestHarness({
      llamaComplete: scriptedToolThenReply(),
    });
    try {
      const response = await postChat(harness.baseUrl, {
        model: "atomic-agent",
        stream: true,
        messages: [{ role: "user", content: "inspect the page" }],
      });
      expect(response.status).toBe(200);
      const text = await readAllText(response);
      expect(text).not.toMatch(/event: session_id\n/);
      expect(text).not.toMatch(/event: tool_progress\n/);
      expect(text).not.toMatch(/event: usage\n/);
      expect(text).not.toMatch(/chat\.completion\.session/);
      expect(text).toMatch(/"content":"after one tool"/);
      expect(text).toMatch(/data: \[DONE\]/);
      expect(response.headers.get(SESSION_ID_HEADER.toLowerCase())).toMatch(/^api-/);
    } finally {
      await harness.cleanup();
    }
  });

  it("emits errors as a canonical OpenAI envelope when extensions are off", async () => {
    const harness = await startTestHarness({
      llamaComplete: async () => {
        throw new Error("llama backend exploded");
      },
    });
    try {
      const response = await postChat(harness.baseUrl, {
        model: "atomic-agent",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(response.status).toBe(200);
      const text = await readAllText(response);
      expect(text).not.toMatch(/event: error\n/);
      expect(text).toMatch(/data: \{"error":\{/);
      expect(text).toMatch(/"message":"[^"]*llama backend exploded/);
      expect(text).toMatch(/"type":"server_error"/);
      expect(text).toMatch(/data: \[DONE\]/);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the legacy named error event when extensions are opted in", async () => {
    const harness = await startTestHarness({
      llamaComplete: async () => {
        throw new Error("llama backend exploded");
      },
    });
    try {
      const response = await postChat(
        harness.baseUrl,
        {
          model: "atomic-agent",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
        { [EXTENSIONS_HEADER]: "1" },
      );
      expect(response.status).toBe(200);
      const text = await readAllText(response);
      expect(text).toMatch(/event: error\n/);
      expect(text).toMatch(/"error":"[^"]*llama backend exploded/);
      expect(text).toMatch(/data: \[DONE\]/);
    } finally {
      await harness.cleanup();
    }
  });

  it("streams incremental content deltas and reasoning_progress events when the LLM streams", async () => {
    const raw =
      '<think>short plan</think>{"tool":"reply","args":{"text":"Hello world"}}';
    const unaryResult: CompletionResult = {
      content: raw,
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 1,
        predictedTokens: 1,
      },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    };
    async function* streamChunks(): AsyncGenerator<
      { delta: string; reasoningDelta: string; done: boolean },
      CompletionResult,
      void
    > {
      for (const ch of raw) {
        yield { delta: ch, reasoningDelta: "", done: false };
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return unaryResult;
    }
    const harness = await startTestHarness({
      llamaComplete: async () => unaryResult,
      llamaCompleteStream: () => streamChunks(),
    });
    try {
      const response = await postChat(
        harness.baseUrl,
        {
          model: "atomic-agent",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
        { [EXTENSIONS_HEADER]: "1" },
      );
      expect(response.status).toBe(200);
      const text = await readAllText(response);
      expect(text).toMatch(/event: reasoning_progress\n/);
      // Multiple content chunks were emitted (one per streamed char, which
      // is more than the single terminal chunk we'd see without streaming).
      const contentChunkCount = (text.match(/"content":/g) ?? []).length;
      expect(contentChunkCount).toBeGreaterThan(1);
      // The last chunk's text still spells the full reply when concatenated.
      const allContent = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => JSON.parse(`"${m[1]}"`) as string)
        .join("");
      expect(allContent).toBe("Hello world");
      expect(text).toMatch(/data: \[DONE\]/);
    } finally {
      await harness.cleanup();
    }
  });
});

/**
 * A steer accepted mid-turn but never shown to the model must not
 * evaporate when the turn closes. `runTurn` hands it back on
 * `RunTurnResult.undelivered`; these pin that this route consumes it —
 * on the response where one can be carried, and in the undelivered
 * store always, because the host that sent the steer is generally not
 * the one holding this response.
 */
describe("POST /v1/chat/completions undelivered steers", () => {
  function instantReply(text: string): CompletionResult {
    return {
      content: JSON.stringify({ tool: "reply", args: { text } }),
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 1,
        predictedTokens: 1,
      },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: null,
    };
  }

  /**
   * Steer from inside the final inference. The loop drains at the top
   * of a step and this turn replies on the step already running, so no
   * later boundary exists to drain it. `### respond` identifies the
   * agent step — the recall/reflection helper prompts run on the same
   * session id before the loop's first drain.
   */
  function steeringLlama(sessionIdRef: { current: string | null }, text: string) {
    let steered = false;
    return async (params: {
      sessionId: string;
      prompt: string;
      steer?: (sessionId: string, text: string) => boolean;
    }): Promise<CompletionResult> => {
      if (
        !steered &&
        params.sessionId === sessionIdRef.current &&
        params.prompt.includes("### respond")
      ) {
        steered = true;
        params.steer?.(params.sessionId, text);
      }
      return instantReply("done");
    };
  }

  it("reports the stranded steer on the completion body and parks it", async () => {
    const sessionIdRef = { current: null as string | null };
    let steerFn: ((sessionId: string, text: string) => boolean) | null = null;
    const base = steeringLlama(sessionIdRef, "stop and summarise");
    const harness = await startTestHarness({
      llamaComplete: (params) =>
        base({ ...params, ...(steerFn ? { steer: steerFn } : {}) }),
    });
    try {
      steerFn = (id, text) => harness.runtime.steer(id, text);
      const session = harness.runtime.createSession();
      sessionIdRef.current = session.id;
      const response = await postChat(harness.baseUrl, {
        session_id: session.id,
        messages: [{ role: "user", content: "go" }],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        undelivered_steers?: Array<{ seq: number; text: string; parked_at: number }>;
      };
      expect(body.undelivered_steers).toEqual([
        {
          seq: expect.any(Number) as unknown as number,
          text: "stop and summarise",
          parked_at: expect.any(Number) as unknown as number,
        },
      ]);
      // The same entry, not a second copy of the message: acking the
      // seq the body reported clears exactly this one.
      const parked = harness.handle.undeliveredSteers.list(session.id);
      expect(parked.map((e) => e.seq)).toEqual(
        body.undelivered_steers?.map((e) => e.seq),
      );
      expect(harness.handle.undeliveredSteers.ack(session.id, parked[0]!.seq)).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("omits the field entirely when the turn delivered everything", async () => {
    const harness = await startTestHarness({
      llamaComplete: scriptedLlama(["hi back"]),
    });
    try {
      const response = await postChat(harness.baseUrl, {
        messages: [{ role: "user", content: "hello" }],
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect("undelivered_steers" in body).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("parks it even when the turn fails and the body is an error envelope", async () => {
    const sessionIdRef = { current: null as string | null };
    let steerFn: ((sessionId: string, text: string) => boolean) | null = null;
    let failed = false;
    const harness = await startTestHarness({
      llamaComplete: async (params) => {
        if (
          params.sessionId === sessionIdRef.current &&
          params.prompt.includes("### respond")
        ) {
          steerFn?.(params.sessionId, "stop, the branch is wrong");
          failed = true;
          throw new Error("llama backend exploded");
        }
        return instantReply("done");
      },
    });
    try {
      steerFn = (id, text) => harness.runtime.steer(id, text);
      const session = harness.runtime.createSession();
      sessionIdRef.current = session.id;
      const response = await postChat(harness.baseUrl, {
        session_id: session.id,
        messages: [{ role: "user", content: "go" }],
      });
      expect(failed).toBe(true);
      expect(response.status).toBe(500);
      // Nothing on the wire could carry it, so the store is the only
      // place it can be — and it is there.
      expect(
        harness.handle.undeliveredSteers.list(session.id).map((e) => e.text),
      ).toEqual(["stop, the branch is wrong"]);
      expect(harness.runtime.steeringInbox.peek(session.id)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("emits a steer_undelivered SSE event to extension clients", async () => {
    const sessionIdRef = { current: null as string | null };
    let steerFn: ((sessionId: string, text: string) => boolean) | null = null;
    const base = steeringLlama(sessionIdRef, "abort the deploy");
    const harness = await startTestHarness({
      llamaComplete: (params) =>
        base({ ...params, ...(steerFn ? { steer: steerFn } : {}) }),
    });
    try {
      steerFn = (id, text) => harness.runtime.steer(id, text);
      const session = harness.runtime.createSession();
      sessionIdRef.current = session.id;
      const response = await postChat(
        harness.baseUrl,
        {
          stream: true,
          session_id: session.id,
          messages: [{ role: "user", content: "go" }],
        },
        { [EXTENSIONS_HEADER]: "1" },
      );
      const text = await readAllText(response);
      expect(text).toMatch(/event: steer_undelivered\n/);
      expect(text).toMatch(/"text":"abort the deploy"/);
      expect(text).toMatch(/data: \[DONE\]/);
      expect(
        harness.handle.undeliveredSteers.list(session.id).map((e) => e.text),
      ).toEqual(["abort the deploy"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the vanilla stream clean and leaves the message to be polled", async () => {
    const sessionIdRef = { current: null as string | null };
    let steerFn: ((sessionId: string, text: string) => boolean) | null = null;
    const base = steeringLlama(sessionIdRef, "abort the deploy");
    const harness = await startTestHarness({
      llamaComplete: (params) =>
        base({ ...params, ...(steerFn ? { steer: steerFn } : {}) }),
    });
    try {
      steerFn = (id, text) => harness.runtime.steer(id, text);
      const session = harness.runtime.createSession();
      sessionIdRef.current = session.id;
      const response = await postChat(harness.baseUrl, {
        stream: true,
        session_id: session.id,
        messages: [{ role: "user", content: "go" }],
      });
      const text = await readAllText(response);
      expect(text).not.toMatch(/event: steer_undelivered\n/);
      // Not on this stream, but not lost either: the host reads it off
      // `GET /api/sessions/{id}/steer`.
      const listed = await fetch(
        `${harness.baseUrl}/api/sessions/${session.id}/steer`,
      );
      const body = (await listed.json()) as {
        undelivered: Array<{ text: string }>;
      };
      expect(body.undelivered.map((e) => e.text)).toEqual(["abort the deploy"]);
    } finally {
      await harness.cleanup();
    }
  });
});

async function readAllText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
