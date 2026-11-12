import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { deriveChatSessionId } from "./openai-session-id.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-586: `incognito: true` on a new chat over HTTP (the desktop's path). */

function reply(text: string) {
  return async (): Promise<CompletionResult> => ({
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });
}

describe("incognito chats over HTTP", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ llamaComplete: reply("hi back") });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const chat = async (body: Record<string, unknown>): Promise<string> => {
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "atomic-agent", messages: [{ role: "user", content: "hello" }], ...body }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { session_id: string }).session_id;
  };

  const listed = async (): Promise<string[]> => {
    const response = await fetch(`${harness.baseUrl}/api/sessions?scope=all`);
    return ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
  };

  it("opens a marked chat under its own id, never the derived one", async () => {
    const id = await chat({ incognito: true });
    expect(id).not.toBe(deriveChatSessionId(null, "hello"));
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
    // The same opening prompt in an ordinary chat is a different chat.
    const plain = await chat({});
    expect(plain).toBe(deriveChatSessionId(null, "hello"));
    expect(harness.runtime.sessionStore.load(plain)?.incognito).toBeUndefined();
  });

  it("is never listed, and continues by session_id", async () => {
    const id = await chat({ incognito: true });
    expect(await listed()).not.toContain(id);
    const again = await chat({ session_id: id });
    expect(again).toBe(id);
    expect(harness.runtime.sessionStore.load(id)?.incognito).toBeDefined();
    expect(await listed()).not.toContain(id);
  });

  it("DELETE removes the chat and its trace file", async () => {
    const id = await chat({ incognito: true });
    const response = await fetch(`${harness.baseUrl}/api/sessions/${id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(harness.runtime.sessionStore.load(id)).toBeNull();
    expect(existsSync(join(harness.stateDir, "traces", `${id}.ndjson`))).toBe(false);
  });

  it("an existing ordinary chat stays ordinary", async () => {
    const plain = await chat({});
    await chat({ session_id: plain, incognito: true });
    expect(harness.runtime.sessionStore.load(plain)?.incognito).toBeUndefined();
  });
});
