import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { EXTENSIONS_HEADER, QUESTIONS_HEADER } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * ATO-489: `ask_user` is offered only to a chat client that draws its
 * question card. The desktop app has none until ATO-1502, so an
 * extensions client gets the tool only when it sends
 * `X-Atomic-Questions`; remove the desktop hide when ATO-1502 lands.
 */
describe("ask_user over POST /v1/chat/completions", () => {
  let harness: Harness;
  const prompts: string[] = [];

  beforeEach(async () => {
    prompts.length = 0;
    harness = await startTestHarness({
      llamaComplete: async (params): Promise<CompletionResult> => {
        prompts.push(params.prompt);
        return {
          content: JSON.stringify({ tool: "reply", args: { text: "ok" } }),
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: null,
        };
      },
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function promptFor(headers: Record<string, string>, text: string): Promise<string> {
    const response = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "atomic-agent", messages: [{ role: "user", content: text }] }),
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(prompts.length).toBeGreaterThan(0);
    return prompts.at(-1)!;
  }

  it("leaves ask_user out of a desktop (extensions) turn that does not declare questions", async () => {
    const prompt = await promptFor({ [EXTENSIONS_HEADER]: "1" }, "desktop chat");
    expect(prompt).not.toContain("ask_user");
  });

  it("offers ask_user to an extensions client that declares the question card", async () => {
    const prompt = await promptFor({ [EXTENSIONS_HEADER]: "1", [QUESTIONS_HEADER]: "1" }, "questions chat");
    expect(prompt).toContain("ask_user");
  });

  it("ignores the flag on a plain OpenAI client, which cannot answer one", async () => {
    const prompt = await promptFor({ [QUESTIONS_HEADER]: "1" }, "plain chat");
    expect(prompt).not.toContain("ask_user");
  });
});
