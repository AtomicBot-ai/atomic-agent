import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import {
  projectSessionConversation,
  validSessionCompaction,
} from "../../session/session-compaction.js";
import { createEmptySessionState } from "../../session/session-state.js";
import {
  HANDOFF_DEFAULT_WINDOW,
  HANDOFF_TAIL_RESULT_MAX_CHARS,
  defaultHandoffWindow,
  fitHandoffContext,
  turnTokens,
} from "./fit-context.js";

const word = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/** `rounds` finished turns: request, one tool call + result, reply. */
function longTranscript(rounds: number, resultWords = 400): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let r = 0; r < rounds; r += 1) {
    turns.push(userTurn(`request ${r}: ${word(20)}`, r * 10));
    turns.push(assistantToolCallTurn({ tool: "Bash", args: { command: `step ${r}` }, at: r * 10 + 1 }));
    turns.push(toolResultTurn({ tool: "Bash", status: "ok", summary: word(resultWords), at: r * 10 + 2 }));
    turns.push(assistantReplyTurn(`done ${r}`, { at: r * 10 + 3 }));
  }
  return turns;
}

function sessionOf(turns: ConversationTurn[]) {
  return { ...createEmptySessionState({ id: "s-1", workingDir: "/w" }), turns };
}

describe("fitHandoffContext", () => {
  it("leaves a history that already fits untouched", () => {
    const session = sessionOf(longTranscript(2, 10));
    const result = fitHandoffContext(session, { windowTokens: 32_768 });
    expect(result.compacted).toBe(false);
    expect(result.skipped).toBe("fits");
    expect(result.session).toBe(session);
  });

  it("does nothing without a usable window", () => {
    const session = sessionOf(longTranscript(50));
    expect(fitHandoffContext(session, { windowTokens: 0 }).skipped).toBe("no_window");
  });

  it("summarises the head and keeps the newest records verbatim under the budget", () => {
    const session = sessionOf(longTranscript(80));
    const windowTokens = 16_384;
    const result = fitHandoffContext(session, { windowTokens, now: 5 });
    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(windowTokens);
    expect(result.tokensAfter).toBeLessThanOrEqual(windowTokens / 2);

    // A checkpoint the runtime itself accepts and projects.
    const checkpoint = validSessionCompaction(result.session);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint).toMatchObject({ kind: "extractive", model: null, createdAt: 5 });
    expect(checkpoint!.coveredThrough).toBe(result.summarizedTurns);

    // The cut lands on a finished turn: the next kept record is a request.
    expect(result.session.turns[result.summarizedTurns]!.kind).toBe("user");
    // The newest request is still there verbatim.
    const projected = projectSessionConversation(result.session);
    expect(projected.turns.at(-4)).toMatchObject({ kind: "user" });
    expect(projected.summary).toContain("Extractive summary of conversation records 0-");
    // Nothing was dropped from the durable transcript.
    expect(result.session.turns).toHaveLength(session.turns.length);
  });

  it("clips very long tool outputs in the kept tail only", () => {
    const turns = longTranscript(40);
    turns.push(userTurn("last request", 1_000));
    turns.push(assistantToolCallTurn({ tool: "Read", args: {}, at: 1_001 }));
    turns.push(toolResultTurn({ tool: "Read", status: "ok", summary: "x".repeat(40_000), at: 1_002 }));
    turns.push(assistantReplyTurn("read it", { at: 1_003 }));
    const result = fitHandoffContext(sessionOf(turns), { windowTokens: 16_384 });
    expect(result.compacted).toBe(true);
    expect(result.clippedResults).toBe(1);
    const clipped = result.session.turns.at(-2)!;
    expect(clipped).toMatchObject({ kind: "tool_result", truncated: true });
    expect(clipped.kind === "tool_result" && clipped.summary.length).toBeLessThanOrEqual(
      HANDOFF_TAIL_RESULT_MAX_CHARS + 200,
    );
  });

  it("refuses to cut through an unanswered call in the middle", () => {
    const turns: ConversationTurn[] = [
      assistantToolCallTurn({ tool: "Bash", args: {}, at: 2 }),
      userTurn(word(4_000), 3),
      assistantReplyTurn(word(4_000), { at: 4 }),
    ];
    const result = fitHandoffContext(sessionOf(turns), { windowTokens: 4_096 });
    expect(result.compacted).toBe(false);
    expect(result.skipped).toBe("no_safe_cut");
  });
});

describe("defaultHandoffWindow", () => {
  it("uses the pinned context, clamps the model-max sentinel, falls back to 32k", () => {
    expect(defaultHandoffWindow(0)).toBe(HANDOFF_DEFAULT_WINDOW);
    expect(defaultHandoffWindow(65_536)).toBe(65_536);
    expect(defaultHandoffWindow(1_048_576)).toBe(131_072);
  });
});

describe("turnTokens", () => {
  it("counts tool results by their body", () => {
    const small = turnTokens(toolResultTurn({ tool: "t", status: "ok", summary: "a", at: 1 }));
    const big = turnTokens(toolResultTurn({ tool: "t", status: "ok", summary: word(500), at: 1 }));
    expect(big).toBeGreaterThan(small);
  });
});
