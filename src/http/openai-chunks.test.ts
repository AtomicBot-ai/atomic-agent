import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../agent/agent-loop.js";
import { createEmptySessionState } from "../session/session-state.js";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import { buildFinalAssistantPayload } from "./openai-chunks.js";

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
});
