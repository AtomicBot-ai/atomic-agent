import { afterEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/provider/completion-types.js";
import { SIDE_QUESTION_MAX_INPUT_CHARS, sideQuestionPartition } from "../runtime/side-question.js";
import { createEmptySessionState, type SessionState } from "../session/index.js";
import { sideQuestionBodyError } from "./route-side-question.js";
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
  const res = await fetch(`${baseUrl}/api/btw`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/btw (ATO-1152)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("answers with the chat as context and writes nothing to it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    harness = await startTestHarness({
      llamaComplete: async (params) => {
        calls.push(params as unknown as Record<string, unknown>);
        return result("You picked port 8080.");
      },
    });
    const state: SessionState = {
      ...createEmptySessionState({ id: "btw-1", workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "Run the server on port 8080", at: 1 },
        { kind: "assistant_reply", text: "Started on 8080.", at: 2 },
      ],
      turnCount: 1,
      macroTurnStarts: [2],
    };
    harness.runtime.sessionStore.save(state);
    const listed = harness.runtime.sessionStore.listRecent(100).length;

    const { status, json } = await post(harness.baseUrl, { question: " which port? ", session_id: "btw-1" });

    expect(status).toBe(200);
    expect(json.text).toBe("You picked port 8080.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(sideQuestionPartition("btw-1"));
    expect(calls[0]?.tools).toBeUndefined();
    expect(String(calls[0]?.prompt)).toContain("which port?");
    expect(String(calls[0]?.prompt)).toContain("port 8080");
    const after = harness.runtime.sessionStore.load("btw-1");
    expect(after?.turns).toHaveLength(2);
    expect(harness.runtime.sessionStore.listRecent(100).length).toBe(listed);
  });

  it("answers without a chat, and for an unknown one, with no context", async () => {
    const calls: Array<Record<string, unknown>> = [];
    harness = await startTestHarness({
      llamaComplete: async (params) => {
        calls.push(params as unknown as Record<string, unknown>);
        return result("ok");
      },
    });
    expect((await post(harness.baseUrl, { question: "hi" })).status).toBe(200);
    expect((await post(harness.baseUrl, { question: "hi", session_id: "nope" })).status).toBe(200);
    expect(calls[0]?.sessionId).toBe(sideQuestionPartition(undefined));
    expect(harness.runtime.sessionStore.load("nope")).toBeNull();
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
    expect((await post(harness.baseUrl, { question: "  " })).status).toBe(400);
    expect((await post(harness.baseUrl, { question: "x".repeat(SIDE_QUESTION_MAX_INPUT_CHARS + 1) })).status).toBe(400);
    expect((await post(harness.baseUrl, { question: "hi", session_id: 5 })).status).toBe(400);
    expect((await post(harness.baseUrl, "[1,2]")).status).toBe(400);
    expect((await post(harness.baseUrl, "{not json")).status).toBe(400);
    expect(called).toBe(0);
  });

  it("answers 502 when the model answers nothing", async () => {
    harness = await startTestHarness({ llamaComplete: async () => result("   ") });
    const { status, json } = await post(harness.baseUrl, { question: "hi" });
    expect(status).toBe(502);
    expect(json.error).toBeDefined();
  });

  it("requires the same bearer key as the other /api routes", async () => {
    harness = await startTestHarness({ apiKey: "secret-key", llamaComplete: async () => result("ok") });
    expect((await post(harness.baseUrl, { question: "hi" })).status).toBe(401);
    const authed = await post(harness.baseUrl, { question: "hi" }, { authorization: "Bearer secret-key" });
    expect(authed.status).toBe(200);
    expect(authed.json.text).toBe("ok");
  });
});

describe("sideQuestionBodyError", () => {
  it("names the field that is wrong", () => {
    expect(sideQuestionBodyError({ question: "hi" })).toBeNull();
    expect(sideQuestionBodyError({ question: "hi", session_id: null })).toBeNull();
    expect(sideQuestionBodyError({ question: 3 })?.param).toBe("question");
    expect(sideQuestionBodyError({ question: "hi", session_id: [] })?.param).toBe("session_id");
  });
});
