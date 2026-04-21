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
});
