import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";

const bigFile = Array.from(
  { length: 300 },
  (_, i) => `line ${i + 1} ${"y".repeat(30)}`,
).join("\n");

function readCall(args: Record<string, unknown>, at: number) {
  return assistantToolCallTurn({ tool: "os.fs.read", args, at });
}

function readResult(at: number) {
  return toolResultTurn({
    tool: "os.fs.read",
    status: "ok",
    summary: bigFile,
    at,
  });
}

function pagingHints(rendered: string): { shown: number; next: string }[] {
  return [
    ...rendered.matchAll(
      /prompt shows the first (\d+) lines of this read.*?call os\.fs\.read with (offset: \d+|the line after the last one shown as `offset`)/g,
    ),
  ].map((m) => ({ shown: Number(m[1]), next: m[2]! }));
}

describe("renderPackedConversation", () => {
  it("names the offset after the range each os.fs.read started at, in call order", () => {
    const rendered = renderPackedConversation({
      visibleTurns: [
        userTurn("review the game", 1),
        readCall({ path: "js/main.js" }, 2),
        readCall({ path: "js/ship.js", offset: 101, limit: 300 }, 3),
        readResult(4),
        readResult(5),
      ],
      droppedSummary: null,
    });
    const [first, second] = pagingHints(rendered);
    expect(first!.next).toBe(`offset: ${first!.shown + 1}`);
    expect(second!.next).toBe(`offset: ${second!.shown + 101}`);
  });

  it("leaves the offset unnamed when it cannot be known", () => {
    const rendered = renderPackedConversation({
      visibleTurns: [
        // Counted from the end of a file whose length the renderer does not know.
        readCall({ path: "js/main.js", offset: -300 }, 1),
        readResult(2),
        assistantReplyTurn("done", 3),
        // No call in view for this result: the reply reset the pairing.
        readResult(4),
      ],
      droppedSummary: null,
    });
    expect(pagingHints(rendered).map((h) => h.next)).toEqual([
      "the line after the last one shown as `offset`",
      "the line after the last one shown as `offset`",
    ]);
  });
});
