import { describe, expect, it } from "vitest";
import { assistantReplyTurn, assistantToolCallTurn, toolResultTurn, userTurn, type ConversationTurn } from "../session/conversation-turn.js";
import { requestContinuingAfterCut, requestContinuingNote, turnEndsAfterCut } from "./compaction-open-request.js";

const turns: ConversationTurn[] = [
  userTurn("first report"), assistantReplyTurn("first done"),
  userTurn("second report"),
  assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/a" } }), toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "a" }),
  assistantReplyTurn("still reading", { progressNote: true }),
  assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/b" } }), toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "b" }),
  assistantReplyTurn("second done"),
];

describe("request still handled after the cut", () => {
  it("finds the newest covered request when the cut is right after it or inside its turn", () => {
    expect(requestContinuingAfterCut(turns, 0, 3)).toBe(2);
    expect(requestContinuingAfterCut(turns, 0, 5)).toBe(2);
    // A progress note does not answer the request.
    expect(requestContinuingAfterCut(turns, 0, 8)).toBe(2);
    expect(requestContinuingNote(turns, 0, 3)).toContain("Record 2 is a user request that is still being handled");
  });

  it("is absent after an answer, without a request in range, or at the end of the transcript", () => {
    expect(requestContinuingAfterCut(turns, 0, 2)).toBeNull();
    expect(requestContinuingAfterCut(turns, 3, 5)).toBeNull();
    expect(requestContinuingAfterCut(turns, 0, turns.length)).toBeNull();
    expect(requestContinuingNote(turns, 0, 2)).toBeNull();
  });

  it("keeps what remains when the turn is still running after the cut", () => {
    const running = turns.slice(0, 8);
    expect(turnEndsAfterCut(turns, 5)).toBe(true);
    expect(turnEndsAfterCut(running, 5)).toBe(false);
    const note = requestContinuingNote(running, 0, 5)!;
    expect(note).toContain("Record 2 is the user request still in progress");
    expect(note).toContain("what still remained to do");
    expect(note).not.toContain("answer come");
  });
});
