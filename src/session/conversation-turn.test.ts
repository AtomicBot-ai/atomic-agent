import { describe, it, expect } from "vitest";
import {
  appendTurn,
  assistantReplyTurn,
  assistantToolCallTurn,
  renderTurnForPrompt,
  toolResultTurn,
  trimTurnsToTokens,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

describe("conversation-turn helpers", () => {
  it("builds typed turns with expected fields", () => {
    const u = userTurn("hi", 1);
    expect(u).toEqual({ kind: "user", text: "hi", at: 1 });

    const call = assistantToolCallTurn({
      tool: "browser.navigate",
      args: { url: "https://example.com" },
      reasoning: "thinking",
      at: 2,
    });
    expect(call).toEqual({
      kind: "assistant_tool_call",
      tool: "browser.navigate",
      args: { url: "https://example.com" },
      reasoning: "thinking",
      at: 2,
    });

    const noReasoning = assistantToolCallTurn({
      tool: "finish",
      args: {},
      at: 3,
    });
    expect(noReasoning).not.toHaveProperty("reasoning");

    const res = toolResultTurn({
      tool: "browser.navigate",
      status: "ok",
      summary: "navigated",
      truncated: true,
      at: 4,
    });
    expect(res).toEqual({
      kind: "tool_result",
      tool: "browser.navigate",
      status: "ok",
      summary: "navigated",
      truncated: true,
      at: 4,
    });

    const reply = assistantReplyTurn("done", 5);
    expect(reply).toEqual({ kind: "assistant_reply", text: "done", at: 5 });
  });

  it("renders each turn kind as a single line", () => {
    expect(renderTurnForPrompt(userTurn("hello", 1))).toBe("user: hello");
    expect(
      renderTurnForPrompt(
        assistantToolCallTurn({ tool: "finish", args: { x: 1 }, at: 2 }),
      ),
    ).toBe('assistant_tool_call: finish {"x":1}');
    expect(
      renderTurnForPrompt(
        toolResultTurn({
          tool: "os.fs.read",
          status: "ok",
          summary: "42 bytes",
          at: 3,
        }),
      ),
    ).toBe("tool_result[os.fs.read ok]: 42 bytes");
    expect(
      renderTurnForPrompt(
        toolResultTurn({
          tool: "os.fs.read",
          status: "error",
          summary: "nope",
          truncated: true,
          at: 3,
        }),
      ),
    ).toBe("tool_result[os.fs.read error]: nope (truncated)");
    expect(
      renderTurnForPrompt(assistantReplyTurn("there", 4)),
    ).toBe("assistant: there");
  });

  it("appendTurn returns a new array without mutating", () => {
    const turns = [userTurn("hi", 1)];
    const next = appendTurn(turns, assistantReplyTurn("hey", 2));
    expect(next).toHaveLength(2);
    expect(turns).toHaveLength(1);
  });

  describe("trimTurnsToTokens", () => {
    it("returns everything when it fits", () => {
      const turns: ConversationTurn[] = [
        userTurn("hi", 1),
        assistantReplyTurn("hey", 2),
      ];
      const out = trimTurnsToTokens(turns, 1000);
      expect(out.truncated).toBe(false);
      expect(out.turns).toEqual(turns);
    });

    it("drops the oldest turns first", () => {
      const turns: ConversationTurn[] = [];
      for (let i = 0; i < 20; i += 1) {
        turns.push(userTurn(`msg${i} ${"x".repeat(40)}`, i));
        turns.push(assistantReplyTurn(`reply${i} ${"y".repeat(40)}`, i));
      }
      const out = trimTurnsToTokens(turns, 60);
      expect(out.truncated).toBe(true);
      expect(out.turns.length).toBeLessThan(turns.length);
      expect(out.turns.at(-1)).toEqual(turns.at(-1));
    });

    it("keeps the last user turn even if it does not fit by itself", () => {
      const turns: ConversationTurn[] = [
        userTurn("old old old old", 1),
        assistantReplyTurn("ok", 2),
        userTurn("brand new user message with plenty of words here", 3),
      ];
      const out = trimTurnsToTokens(turns, 1);
      expect(out.truncated).toBe(true);
      expect(out.turns.at(-1)?.kind).toBe("user");
    });

    it("empty history returns empty", () => {
      expect(trimTurnsToTokens([], 100)).toEqual({
        turns: [],
        truncated: false,
      });
    });

    it("non-positive budget drops everything", () => {
      const out = trimTurnsToTokens([userTurn("hi", 1)], 0);
      expect(out).toEqual({ turns: [], truncated: true });
    });
  });
});
