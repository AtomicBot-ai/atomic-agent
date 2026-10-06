import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import {
  packedConversationTurns,
  renderPackedConversation,
} from "./build-prompt-world-conversation.js";

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

describe("packedConversationTurns", () => {
  it("caps each tool-result body exactly as the flat rendering does", () => {
    const packed = {
      visibleTurns: [
        userTurn("review the game", 1),
        readCall({ path: "js/main.js" }, 2),
        readCall({ path: "js/ship.js", offset: 101, limit: 300 }, 3),
        readResult(4),
        readResult(5),
        assistantReplyTurn("done", 6),
      ],
      droppedSummary: "summary: older turns",
    };
    const flat = renderPackedConversation(packed).split("\n");
    const turns = packedConversationTurns(packed);
    expect(turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_tool_call",
      "assistant_tool_call",
      "tool_result",
      "tool_result",
      "assistant_reply",
    ]);
    // Every structured body appears verbatim behind its flat header:
    // the same cap, the same paging hint, the same offset.
    const rendered = renderPackedConversation(packed);
    const structuredBodies = turns
      .filter((t): t is Extract<typeof t, { kind: "tool_result" }> => t.kind === "tool_result")
      .map((t) => t.body);
    expect(structuredBodies).toHaveLength(2);
    for (const body of structuredBodies) {
      expect(body.length).toBeLessThan(bigFile.length);
      expect(rendered).toContain(`tool_result[os.fs.read ok]: ${body}`);
    }
    expect(structuredBodies[0]).toContain("offset: ");
    expect(structuredBodies[1]).toContain("offset: ");
    expect(structuredBodies[0]).not.toBe(structuredBodies[1]);
    expect(flat[0]).toBe("summary: older turns");
  });

  it("carries a reply's attachment note the way the flat line does", () => {
    const turns = packedConversationTurns({
      visibleTurns: [
        assistantReplyTurn("here", { at: 1, attachments: ["/tmp/a.png"] }),
        toolResultTurn({ tool: "os.shell.run", status: "error", summary: "boom", truncated: true, at: 2 }),
      ],
      droppedSummary: null,
    });
    expect(turns).toEqual([
      { kind: "assistant_reply", text: "here (attached: /tmp/a.png)" },
      { kind: "tool_result", tool: "os.shell.run", status: "error", body: "boom", truncated: true },
    ]);
  });
});

describe("a repeated os.fs.read in the packed conversation", () => {
  const read = {
    path: "/repo/js/main.js",
    contentHash: "c0ffee",
    startLine: 1,
    endLine: 300,
    numbered: false,
  };

  function repeatRow(at: number) {
    return toolResultTurn({
      tool: "os.fs.read",
      status: "ok",
      summary: bigFile,
      truncated: true,
      read,
      at,
    });
  }

  it("draws the second read as a pointer in both prompt forms", () => {
    const packed = {
      visibleTurns: [
        userTurn("review the game", 1),
        readCall({ path: "js/main.js" }, 2),
        repeatRow(3),
        readCall({ path: "js/main.js" }, 4),
        repeatRow(5),
      ],
      droppedSummary: null,
    };
    const flat = renderPackedConversation(packed);
    const pointer =
      "[unchanged since your earlier read: same 300 lines (1-300), identical text — see the os.fs.read result just above; not repeated here]";
    expect(flat).toContain(`tool_result[os.fs.read ok]: ${pointer}`);
    // The first read keeps its text, paging hint and truncated mark.
    expect(pagingHints(flat)).toHaveLength(1);
    expect(flat.match(/\(truncated\)/g)).toHaveLength(1);

    const results = packedConversationTurns(packed).filter(
      (t): t is Extract<typeof t, { kind: "tool_result" }> =>
        t.kind === "tool_result",
    );
    expect(results[0]!.body).toContain("line 1 ");
    expect(results[0]!.truncated).toBe(true);
    expect(results[1]).toEqual({
      kind: "tool_result",
      tool: "os.fs.read",
      status: "ok",
      body: pointer,
      truncated: false,
    });
  });

  it("draws the read in full when the earlier one is not among the visible turns", () => {
    const packed = {
      visibleTurns: [readCall({ path: "js/main.js" }, 4), repeatRow(5)],
      droppedSummary: "summary: 3 older turns dropped",
    };
    const flat = renderPackedConversation(packed);
    expect(flat).not.toContain("[unchanged since your earlier read");
    expect(pagingHints(flat)).toHaveLength(1);
  });
});
