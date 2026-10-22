import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../agent/agent-loop.js";
import { createEmptySessionState } from "../session/session-state.js";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  stoppedTurnMarker,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import { buildFinalAssistantPayload, buildUsageChunk, buildUsagePayload } from "./openai-chunks.js";

function result(
  turns: ReturnType<typeof userTurn>[],
  reason: RunTurnResult["reason"] = "reply",
): RunTurnResult {
  const session = createEmptySessionState({ id: "s-chunks", workingDir: "/w" });
  return {
    session: { ...session, turns },
    reason,
    stepCount: turns.length,
  } as RunTurnResult;
}

describe("buildFinalAssistantPayload", () => {
  it("returns the reply that ended the turn, not a progress note before it", () => {
    const payload = buildFinalAssistantPayload(
      result([
        userTurn("build it", 1),
        assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a" }, at: 2 }),
        toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "x", at: 3 }),
        assistantReplyTurn("(reading first)", { at: 4, progressNote: true }),
        assistantReplyTurn("final answer", 5),
      ]),
    );
    expect(payload).toEqual({
      message: { role: "assistant", content: "final answer" },
      finish_reason: "stop",
    });
  });

  it("never hands a progress note out as the message", () => {
    const payload = buildFinalAssistantPayload(
      result(
        [
          userTurn("build it", 1),
          assistantReplyTurn("(reading first)", { at: 2, progressNote: true }),
        ],
        "max_steps",
      ),
    );
    expect(payload).toEqual({
      message: { role: "assistant", content: "" },
      finish_reason: "length",
    });
  });

  it("hands out neither the stop marker nor an earlier turn's reply for a stopped turn", () => {
    const payload = buildFinalAssistantPayload(
      result(
        [
          userTurn("hello", 1),
          assistantReplyTurn("hi there", 2),
          userTurn("write a long story", 3),
          stoppedTurnMarker(4),
        ],
        "cancelled",
      ),
    );
    expect(payload).toEqual({
      message: { role: "assistant", content: "" },
      finish_reason: "cancelled",
    });
  });
});

describe("buildUsagePayload (ATO-276)", () => {
  it("reports the turn's metered tokens", () => {
    const withUsage = { ...result([userTurn("hi", 1)]), usage: { promptTokens: 150, completionTokens: 10 } } as RunTurnResult;
    expect(buildUsagePayload(withUsage)).toEqual({ prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 });
  });

  it("stays schema-valid with zeros when the provider reported nothing", () => {
    expect(buildUsagePayload(result([userTurn("hi", 1)]))).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("builds OpenAI's include_usage chunk: empty choices plus usage", () => {
    expect(buildUsageChunk({ completionId: "c", created: 1, model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })).toEqual({
      id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  });
});
