import { afterEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { parseAgUiRunInput } from "./route-ag-ui.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-694: `POST /api/ag-ui` runs a turn and answers with AG-UI events. */
function replyOnce(text: string) {
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

function readEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
}

describe("parseAgUiRunInput", () => {
  it("takes the last user message, string or text parts", () => {
    expect(
      parseAgUiRunInput({
        threadId: "t",
        runId: "r",
        messages: [
          { id: "1", role: "user", content: "first" },
          { id: "2", role: "assistant", content: "ok" },
          { id: "3", role: "user", content: [{ type: "text", text: "second" }, { type: "image", url: "x" }] },
        ],
      }),
    ).toEqual({ threadId: "t", runId: "r", userMessage: "second" });
  });

  it("refuses a body without ids or a user message", () => {
    expect(parseAgUiRunInput(null)).toMatch(/RunAgentInput/);
    expect(parseAgUiRunInput({ runId: "r", messages: [] })).toMatch(/threadId/);
    expect(parseAgUiRunInput({ threadId: "t\n", runId: "r", messages: [] })).toMatch(/threadId/);
    expect(parseAgUiRunInput({ threadId: "t", messages: [] })).toMatch(/runId/);
    expect(parseAgUiRunInput({ threadId: "t", runId: "r" })).toMatch(/messages/);
    expect(
      parseAgUiRunInput({ threadId: "t", runId: "r", messages: [{ id: "1", role: "assistant", content: "x" }] }),
    ).toMatch(/user message/);
  });
});

describe("POST /api/ag-ui", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("answers 400 for a body that is not a RunAgentInput", async () => {
    harness = await startTestHarness({ llamaComplete: replyOnce("hi") });
    const response = await fetch(`${harness.baseUrl}/api/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("streams RUN_STARTED, the reply as a text message and RUN_FINISHED, in the thread's session", async () => {
    harness = await startTestHarness({ llamaComplete: replyOnce("hi back") });
    const response = await fetch(`${harness.baseUrl}/api/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: "agui-thread-1",
        runId: "run-1",
        state: {},
        tools: [],
        context: [],
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = readEvents(await response.text());
    const types = events.map((e) => e["type"]);
    expect(types[0]).toBe("RUN_STARTED");
    expect(events[0]).toMatchObject({ threadId: "agui-thread-1", runId: "run-1" });
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(events.at(-1)).toMatchObject({ threadId: "agui-thread-1", runId: "run-1", outcome: { type: "success" } });
    const text = events
      .filter((e) => e["type"] === "TEXT_MESSAGE_CONTENT")
      .map((e) => e["delta"])
      .join("");
    expect(text).toBe("hi back");
    // Every message that opened was closed.
    expect(types.filter((t) => t === "TEXT_MESSAGE_START").length).toBe(
      types.filter((t) => t === "TEXT_MESSAGE_END").length,
    );
    expect(types).not.toContain("TOOL_CALL_START");
    expect(harness.runtime.sessionStore.load("agui-thread-1")).not.toBeNull();
  });
});
