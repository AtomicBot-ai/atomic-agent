import { describe, expect, it } from "vitest";
import { assistantReplyTurn, assistantToolCallTurn, stoppedTurnMarker, toolResultTurn, userTurn, type ConversationTurn } from "./conversation-turn.js";
import { finishedTurnCompactionCuts, preferredCompactionCuts, safeCompactionCuts } from "./session-compaction.js";

const step = (path: string): ConversationTurn[] => [
  assistantToolCallTurn({ tool: "os.fs.read", args: { path } }),
  toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `read ${path}` }),
];

describe("finished-turn compaction cuts", () => {
  it("keeps a request with its answer and lists cuts inside a turn after them", () => {
    const turns = [userTurn("first"), ...step("/a"), assistantReplyTurn("done a"), userTurn("second"), ...step("/b")];
    expect(safeCompactionCuts(turns)).toEqual([1, 3, 4, 5, 7]);
    expect(finishedTurnCompactionCuts(turns)).toEqual([4]);
    expect(preferredCompactionCuts(turns)).toEqual([4, 1, 3, 5, 7]);
  });

  it("does not treat a progress note as the end of a turn, but does a stop marker and the end of the transcript", () => {
    const turns = [userTurn("first"), assistantReplyTurn("working on it", { progressNote: true }), ...step("/a"),
      stoppedTurnMarker(), userTurn("second"), assistantReplyTurn("done")];
    expect(finishedTurnCompactionCuts(turns)).toEqual([5, 7]);
  });
});
