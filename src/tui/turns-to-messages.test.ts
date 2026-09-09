import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../session/conversation-turn.js";
import { turnsToMessages } from "./turns-to-messages.js";

describe("turnsToMessages", () => {
  it("converts an empty turn list into an empty message list", () => {
    expect(turnsToMessages([])).toEqual([]);
  });

  it("folds a user -> tool -> reply turn into user + assistant messages", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "run lint", at: 100 },
      {
        kind: "assistant_tool_call",
        tool: "shell.exec",
        args: { cmd: "npm run lint" },
        at: 101,
      },
      {
        kind: "tool_result",
        tool: "shell.exec",
        status: "ok",
        summary: "0 errors",
        at: 102,
      },
      { kind: "assistant_reply", text: "clean", at: 103 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", text: "run lint" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "clean",
      toolSteps: 1,
    });
    expect(messages[1]?.toolCards).toHaveLength(1);
    expect(messages[1]?.toolCards?.[0]).toMatchObject({
      tool: "shell.exec",
      status: "ok",
      summary: "0 errors",
      args: { cmd: "npm run lint" },
    });
  });

  it("groups multiple tool calls under the same assistant reply", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "inspect", at: 1 },
      { kind: "assistant_tool_call", tool: "shell.exec", args: { cmd: "ls" }, at: 2 },
      { kind: "tool_result", tool: "shell.exec", status: "ok", summary: "a b", at: 3 },
      { kind: "assistant_tool_call", tool: "shell.exec", args: { cmd: "pwd" }, at: 4 },
      { kind: "tool_result", tool: "shell.exec", status: "ok", summary: "/tmp", at: 5 },
      { kind: "assistant_reply", text: "done", at: 6 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.toolCards).toHaveLength(2);
    expect(messages[1]?.toolSteps).toBe(2);
  });

  it("preserves reasoning blocks attached to tool calls", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "think", at: 1 },
      {
        kind: "assistant_tool_call",
        tool: "reply",
        args: { text: "ok" },
        reasoning: "I should just answer",
        at: 2,
      },
      { kind: "tool_result", tool: "reply", status: "ok", summary: "replied", at: 3 },
      { kind: "assistant_reply", text: "ok", at: 4 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages[1]?.reasoningBlocks).toEqual(["I should just answer"]);
    expect(messages[1]?.toolSteps).toBe(0);
  });

  it("materialises an assistant message even without a reply when the turn is in progress", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "run", at: 1 },
      { kind: "assistant_tool_call", tool: "shell.exec", args: { cmd: "ls" }, at: 2 },
      { kind: "tool_result", tool: "shell.exec", status: "ok", summary: "a", at: 3 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.toolCards).toHaveLength(1);
  });

  it("restores reasoning of the final assistant_reply turn from persisted sessions", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "hi", at: 1 },
      {
        kind: "assistant_reply",
        text: "Hello there",
        reasoning: "thought process for the final reply",
        at: 2,
      },
    ];
    const messages = turnsToMessages(turns);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.text).toBe("Hello there");
    expect(messages[1]?.reasoningBlocks).toContain(
      "thought process for the final reply",
    );
  });

  it("gives two replies that finish in the same millisecond distinct ids", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "a", at: 5 },
      { kind: "assistant_reply", text: "one", at: 5 },
      { kind: "user", text: "b", at: 5 },
      { kind: "assistant_reply", text: "two", at: 5 },
    ];
    const ids = turnsToMessages(turns).map((m) => m.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[1]).toBe("msg-asst-1-5");
    expect(ids[3]).toBe("msg-asst-3-5");
  });

  it("skips a turn of unknown kind instead of throwing", () => {
    const turns = [
      { kind: "user", text: "hi", at: 1 },
      { kind: "system_note", text: "??", at: 2 },
      { kind: "assistant_reply", text: "hello", at: 3 },
    ] as unknown as ConversationTurn[];
    const messages = turnsToMessages(turns);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.text).toBe("hello");
  });

  it("drops a reply with no text, no tool cards and no reasoning", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "hi", at: 1 },
      { kind: "assistant_reply", text: "", at: 2 },
      { kind: "user", text: "still there?", at: 3 },
      { kind: "assistant_reply", text: "yes", at: 4 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hi"],
      ["user", "still there?"],
      ["assistant", "yes"],
    ]);
  });

  it("keeps an empty reply that carries reasoning as a reasoning-only message", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "hi", at: 1 },
      { kind: "assistant_reply", text: "", reasoning: "interrupted", at: 2 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "",
      reasoningBlocks: ["interrupted"],
    });
  });

  it("keeps an empty reply that closes a tool chain", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "run", at: 1 },
      { kind: "assistant_tool_call", tool: "shell.exec", args: {}, at: 2 },
      { kind: "tool_result", tool: "shell.exec", status: "ok", summary: "a", at: 3 },
      { kind: "assistant_reply", text: "", at: 4 },
    ];
    const messages = turnsToMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.toolCards).toHaveLength(1);
    expect(messages[1]?.toolSteps).toBe(1);
  });

  it("coerces non-string text and summaries to strings", () => {
    const turns = [
      { kind: "user", text: 42, at: 1 },
      { kind: "assistant_tool_call", tool: "x", args: {}, at: 2 },
      { kind: "tool_result", tool: "x", status: "ok", summary: { ok: true }, at: 3 },
      { kind: "assistant_reply", text: null, reasoning: ["a", "b"], at: 4 },
    ] as unknown as ConversationTurn[];
    const messages = turnsToMessages(turns);
    expect(messages[0]?.text).toBe("42");
    expect(messages[1]?.toolCards?.[0]?.summary).toBe('{"ok":true}');
    expect(messages[1]?.text).toBe("");
    expect(messages[1]?.reasoningBlocks).toEqual(['["a","b"]']);
  });

  it("falls back to the previous turn's time when `at` is missing", () => {
    const turns = [
      { kind: "user", text: "hi", at: 100 },
      { kind: "assistant_reply", text: "hello" },
      { kind: "user", text: "again", at: "soon" },
    ] as unknown as ConversationTurn[];
    const messages = turnsToMessages(turns);
    expect(messages.map((m) => m.timestamp)).toEqual([100, 100, 100]);
    expect(messages[1]?.id).toBe("msg-asst-1-100");
  });

  it("uses 0 when the first turn has no usable time", () => {
    const turns = [{ kind: "user", text: "hi" }] as unknown as ConversationTurn[];
    expect(turnsToMessages(turns)[0]?.timestamp).toBe(0);
  });
});
