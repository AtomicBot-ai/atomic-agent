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
