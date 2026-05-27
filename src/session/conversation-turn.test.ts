import { describe, it, expect } from "vitest";
import {
  appendTurn,
  assistantReplyTurn,
  assistantToolCallTurn,
  findCurrentMacroTurnStart,
  packConversation,
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

  it("renders assistant turns in editorialised form (no reasoning leak)", () => {
    expect(
      renderTurnForPrompt(
        assistantToolCallTurn({ tool: "finish", args: { x: 1 }, at: 2 }),
      ),
    ).toBe('assistant_tool_call: finish {"x":1}');
    expect(renderTurnForPrompt(assistantReplyTurn("there", 4))).toBe(
      "assistant: there",
    );
  });

  it("caps oversized tool_result summaries at render time", () => {
    const big = "x".repeat(10_000);
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.fs.read_document",
        status: "ok",
        summary: big,
        at: 5,
      }),
    );
    // The cap is 4000 chars minus a tail for the truncation marker, so the
    // rendered block stays below the full 10k summary.
    expect(rendered.length).toBeLessThan(big.length);
    expect(rendered.startsWith("tool_result[os.fs.read_document ok]: ")).toBe(
      true,
    );
    expect(rendered).toContain("[rendering-truncated");
  });

  it("renders fresh os.http.request results uncapped", () => {
    const big = "x".repeat(10_000);
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.http.request",
        status: "ok",
        summary: big,
        at: 7,
      }),
      { inCurrentMacroTurn: true },
    );
    expect(rendered).toBe(`tool_result[os.http.request ok]: ${big}`);
    expect(rendered).not.toContain("[rendering-truncated");
  });

  it("gives fresh gog shell results a larger render budget", () => {
    const body = "x".repeat(8_000);
    const summary = `$ gog --json --no-input gmail search is:unread\n${body}`;
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.shell.run",
        status: "ok",
        summary,
        at: 7,
      }),
      { inCurrentMacroTurn: true },
    );
    expect(rendered).toContain(body);
    expect(rendered).not.toContain("[rendering-truncated");
  });

  it("caps historical os.http.request results to ~400 chars", () => {
    const big = "x".repeat(10_000);
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.http.request",
        status: "ok",
        summary: big,
        at: 7,
      }),
      { inCurrentMacroTurn: false },
    );
    expect(rendered.length).toBeLessThan(800);
    expect(rendered).toContain("[rendering-truncated");
    expect(rendered.startsWith("tool_result[os.http.request ok]: ")).toBe(true);
  });

  it("defaults to history mode for os.http.request when option is omitted", () => {
    const big = "x".repeat(10_000);
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.http.request",
        status: "ok",
        summary: big,
        at: 7,
      }),
    );
    expect(rendered).toContain("[rendering-truncated");
  });

  it("leaves short tool_result summaries untouched", () => {
    const rendered = renderTurnForPrompt(
      toolResultTurn({
        tool: "os.fs.list",
        status: "ok",
        summary: "3 entries: a, b, c",
        at: 6,
      }),
    );
    expect(rendered).toBe("tool_result[os.fs.list ok]: 3 entries: a, b, c");
  });

  describe("findCurrentMacroTurnStart", () => {
    it("returns 0 when no assistant_reply has been emitted", () => {
      const turns: ConversationTurn[] = [
        userTurn("hi", 1),
        assistantToolCallTurn({ tool: "x", args: {}, at: 2 }),
        toolResultTurn({ tool: "x", status: "ok", summary: "s", at: 3 }),
      ];
      expect(findCurrentMacroTurnStart(turns)).toBe(0);
    });

    it("returns 0 for an empty list", () => {
      expect(findCurrentMacroTurnStart([])).toBe(0);
    });

    it("returns the index right after the last assistant_reply", () => {
      const turns: ConversationTurn[] = [
        userTurn("hi", 1),
        assistantReplyTurn("done", 2),
        userTurn("more", 3),
        assistantToolCallTurn({ tool: "x", args: {}, at: 4 }),
        toolResultTurn({ tool: "x", status: "ok", summary: "s", at: 5 }),
      ];
      expect(findCurrentMacroTurnStart(turns)).toBe(2);
    });

    it("returns turns.length when the last turn is an assistant_reply", () => {
      const turns: ConversationTurn[] = [
        userTurn("hi", 1),
        assistantReplyTurn("done", 2),
      ];
      expect(findCurrentMacroTurnStart(turns)).toBe(2);
    });
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

  describe("packConversation", () => {
    it("empty history returns a neutral pack", () => {
      expect(packConversation([], 100)).toEqual({
        visibleTurns: [],
        droppedSummary: null,
        droppedCount: 0,
      });
    });

    it("returns every turn visible and no summary when it fits", () => {
      const turns: ConversationTurn[] = [
        userTurn("hi", 1),
        assistantReplyTurn("hey", 2),
      ];
      const out = packConversation(turns, 1000);
      expect(out.droppedSummary).toBeNull();
      expect(out.droppedCount).toBe(0);
      expect(out.visibleTurns).toEqual(turns);
    });

    it("drops the oldest turns and produces a deterministic summary", () => {
      const base = Date.parse("2026-04-23T10:00:00Z");
      const turns: ConversationTurn[] = [];
      for (let i = 0; i < 10; i += 1) {
        turns.push(userTurn(`msg${i} ${"x".repeat(50)}`, base + i * 1000));
        turns.push(
          assistantToolCallTurn({
            tool: "fs.read",
            args: { path: `/a/b/${i}` },
            at: base + i * 1000 + 100,
          }),
        );
        turns.push(
          toolResultTurn({
            tool: "fs.read",
            status: "ok",
            summary: `read ${i}`,
            at: base + i * 1000 + 200,
          }),
        );
        turns.push(
          assistantReplyTurn(`reply${i} ${"y".repeat(50)}`, base + i * 1000 + 300),
        );
      }
      const out = packConversation(turns, 120);
      expect(out.droppedCount).toBeGreaterThan(0);
      expect(out.droppedCount).toBeLessThan(turns.length);
      expect(out.visibleTurns.at(-1)).toEqual(turns.at(-1));
      expect(out.droppedSummary).toMatch(
        /^summary: \d+ older turns dropped \(\d+ user, \d+ tool calls, \d+ replies; first at \S+, last at \S+\)$/,
      );
    });

    it("counts turn kinds correctly in the summary", () => {
      const turns: ConversationTurn[] = [
        userTurn("u1", 1),
        userTurn("u2", 2),
        assistantToolCallTurn({ tool: "t", args: {}, at: 3 }),
        toolResultTurn({ tool: "t", status: "ok", summary: "s", at: 4 }),
        assistantReplyTurn("r", 5),
        userTurn("keep", 6),
      ];
      const out = packConversation(turns, 1);
      expect(out.droppedSummary).toContain("2 user");
      expect(out.droppedSummary).toContain("1 tool calls");
      expect(out.droppedSummary).toContain("1 replies");
      expect(out.visibleTurns.at(-1)?.kind).toBe("user");
    });

    it("keeps the last user turn even if the budget is tiny", () => {
      const turns: ConversationTurn[] = [
        userTurn("old old old old", 1),
        assistantReplyTurn("ok", 2),
        userTurn("brand new user message with plenty of words here", 3),
      ];
      const out = packConversation(turns, 1);
      expect(out.visibleTurns.at(-1)?.kind).toBe("user");
      expect(out.droppedSummary).not.toBeNull();
      expect(out.droppedCount).toBe(2);
    });

    it("non-positive budget moves everything into the summary", () => {
      const turns: ConversationTurn[] = [
        userTurn("a", 1),
        assistantReplyTurn("b", 2),
      ];
      const out = packConversation(turns, 0);
      expect(out.visibleTurns).toEqual([]);
      expect(out.droppedCount).toBe(2);
      expect(out.droppedSummary).toMatch(/^summary: 2 older turns dropped/);
    });
  });
});
