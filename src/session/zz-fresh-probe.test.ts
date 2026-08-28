import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  pairTokenCosts,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

describe("freshness probe", () => {
  it("prices the in-flight task with an uncapped http body", () => {
    const bigBody = "x".repeat(200_000); // 200KB API response, well under the 1MB cap
    const base: ConversationTurn[] = [
      userTurn("task one", 1),
      assistantReplyTurn("done one", 2),
      userTurn("fetch that API", 3),
      assistantToolCallTurn({ tool: "os.http.request", args: { url: "https://x" }, at: 4 }),
      toolResultTurn({ tool: "os.http.request", status: "ok", summary: bigBody, at: 5 }),
    ];
    // What the panel stores: pairCosts from the LAST prompt_built of the turn,
    // i.e. before the assistant_reply is appended.
    const atBuild = pairTokenCosts(base, [0, 2]);
    // What the next prompt will actually cost once the reply closed the task.
    const closed = [...base, assistantReplyTurn("here it is", 6)];
    const nextTurn = pairTokenCosts(closed, [0, 2]);
    console.log("pairCosts stored by the panel:", atBuild);
    console.log("pairCosts on the next build   :", nextTurn);
    expect(atBuild.length).toBe(2);
  });
});
