import { describe, expect, it } from "vitest";

import { estimateTokens } from "../prompt/token-budget.js";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  findCurrentMacroTurnStart,
  packConversation,
  renderTurnForPrompt,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

// #1735: the pins (last user turn, current task's opening turn) used to
// bring back a suffix the token cut had dropped, oversized tool body and
// all, so the packer returned far more than its budget.

/** What the visible tail costs, rendered the way the prompt renders it. */
function visibleCost(turns: readonly ConversationTurn[]): number {
  const currentStart = findCurrentMacroTurnStart(turns);
  return turns.reduce(
    (sum, turn, i) =>
      sum +
      estimateTokens(
        renderTurnForPrompt(turn, { inCurrentMacroTurn: i >= currentStart }),
      ) +
      1,
    0,
  );
}

function httpTask(body: string): ConversationTurn[] {
  return [
    userTurn("fetch the data", 1),
    assistantToolCallTurn({
      tool: "os.http.request",
      args: { url: "https://example.com/data", method: "GET" },
      at: 2,
    }),
    toolResultTurn({ tool: "os.http.request", status: "ok", summary: body, at: 3 }),
  ];
}

const BIG_BODY = "word ".repeat(18_000); // 90 000 chars

describe("packConversation bounds pinned tool bodies (#1735)", () => {
  it("keeps a short request plus a fresh 90 000-char HTTP result within the budget", () => {
    const turns = httpTask(BIG_BODY);
    const out = packConversation(turns, 2_000);
    // Nothing older to drop: the whole task is pinned.
    expect(out.droppedCount).toBe(0);
    expect(out.visibleTurns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_tool_call",
      "tool_result",
    ]);
    expect(visibleCost(out.visibleTurns)).toBeLessThanOrEqual(2_000);
    const result = out.visibleTurns[2];
    expect(result?.kind === "tool_result" && result.summary).toMatch(
      /more chars of this result are not shown/,
    );
    // The head of the body is what stays visible.
    expect(result?.kind === "tool_result" && result.summary.startsWith("word word")).toBe(true);
  });

  it("leaves the stored transcript untouched", () => {
    const turns = httpTask(BIG_BODY);
    packConversation(turns, 2_000);
    const stored = turns[2];
    expect(stored?.kind === "tool_result" && stored.summary).toBe(BIG_BODY);
  });

  it("changes nothing when the pinned suffix fits", () => {
    const turns = httpTask(BIG_BODY);
    const out = packConversation(turns, 100_000);
    expect(out.visibleTurns[2]).toBe(turns[2]);
  });

  it("keeps the tail of a shell result, where its exit line is", () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i} of the build output`);
    const summary = `${lines.join("\n")}\nexit: 0`;
    const turns: ConversationTurn[] = [
      userTurn("run the build", 1),
      assistantToolCallTurn({ tool: "os.shell.run", args: { command: "make" }, at: 2 }),
      toolResultTurn({ tool: "os.shell.run", status: "ok", summary, at: 3 }),
    ];
    const out = packConversation(turns, 1_000);
    expect(visibleCost(out.visibleTurns)).toBeLessThanOrEqual(1_000);
    const result = out.visibleTurns[2];
    expect(result?.kind === "tool_result" && result.summary.endsWith("exit: 0")).toBe(true);
    expect(result?.kind === "tool_result" && result.summary.includes("line 0 of")).toBe(false);
  });

  it("bounds a pinned body the same way on every step, so the prompt prefix holds", () => {
    const first = packConversation(httpTask(BIG_BODY), 2_000);
    const later = packConversation(
      [
        ...httpTask(BIG_BODY),
        assistantToolCallTurn({ tool: "os.fs.read", args: { path: "a.txt" }, at: 4 }),
        toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "short", at: 5 }),
      ],
      2_000,
    );
    expect(later.visibleTurns[2]).toEqual(first.visibleTurns[2]);
  });

  it("drops older tasks first and bounds only what the pins keep", () => {
    const older: ConversationTurn[] = [
      userTurn("earlier", 0),
      assistantReplyTurn(`done ${"y".repeat(4_000)}`, 0.5),
    ];
    const turns = [...older, ...httpTask(BIG_BODY)];
    const out = packConversation(turns, 2_000);
    expect(out.droppedCount).toBe(2);
    expect(out.visibleTurns[0]).toBe(turns[2]);
    // The summary line takes its reserve out of the same budget.
    expect(visibleCost(out.visibleTurns)).toBeLessThanOrEqual(2_000 - 40);
  });
});
