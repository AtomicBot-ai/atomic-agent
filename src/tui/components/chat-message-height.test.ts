import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../tui-state.js";
import {
  estimateMessageHeight,
  selectVisibleMessages,
} from "./chat-message-height.js";

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: "user", text, timestamp: 1 };
}

function assistantMsg(
  id: string,
  text: string,
  toolSteps = 0,
  reasoning?: readonly string[],
): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    toolSteps,
    timestamp: 2,
    ...(reasoning ? { reasoningBlocks: reasoning } : {}),
  };
}

describe("estimateMessageHeight", () => {
  it("counts a single-line user message as body + bubble overhead", () => {
    const h = estimateMessageHeight(userMsg("u1", "hello"));
    // 1 body + 3 overhead (margin + 2 padding)
    expect(h).toBe(4);
  });

  it("counts assistant footer when toolSteps > 0", () => {
    const without = estimateMessageHeight(assistantMsg("a1", "ok", 0));
    const withFooter = estimateMessageHeight(assistantMsg("a2", "ok", 2));
    expect(withFooter).toBe(without + 1);
  });

  it("adds reasoning envelope when reasoningBlocks is non-empty", () => {
    const without = estimateMessageHeight(assistantMsg("a1", "ok", 0));
    const withReasoning = estimateMessageHeight(
      assistantMsg("a2", "ok", 0, ["thinking..."]),
    );
    expect(withReasoning).toBeGreaterThan(without);
  });
});

describe("selectVisibleMessages", () => {
  it("returns all messages when budget is generous", () => {
    const msgs = [userMsg("u1", "a"), assistantMsg("a1", "b"), userMsg("u2", "c")];
    const slice = selectVisibleMessages(msgs, 0, 100);
    expect(slice.visible.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(slice.hiddenAbove).toBe(0);
    expect(slice.hiddenBelow).toBe(0);
  });

  it("drops dropFromEnd newest first and shows the rest", () => {
    const msgs = [userMsg("u1", "a"), userMsg("u2", "b"), userMsg("u3", "c")];
    const slice = selectVisibleMessages(msgs, 1, 100);
    expect(slice.visible.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(slice.hiddenBelow).toBe(1);
  });

  it("hides oldest messages above when budget is too tight", () => {
    const msgs = [
      userMsg("u1", "a"),
      userMsg("u2", "b"),
      userMsg("u3", "c"),
      userMsg("u4", "d"),
    ];
    // Each 1-line user message costs 4 rows. Budget for 2 messages
    // exactly: 8 rows.
    const slice = selectVisibleMessages(msgs, 0, 8);
    expect(slice.visible.map((m) => m.id)).toEqual(["u3", "u4"]);
    expect(slice.hiddenAbove).toBe(2);
  });

  it("always shows at least one message even when budget is zero", () => {
    const msgs = [userMsg("u1", "a"), userMsg("u2", "b")];
    const slice = selectVisibleMessages(msgs, 0, 0);
    expect(slice.visible.map((m) => m.id)).toEqual(["u2"]);
    expect(slice.hiddenAbove).toBe(1);
  });

  it("returns empty visible when there are no candidate messages", () => {
    const slice = selectVisibleMessages([], 0, 50);
    expect(slice.visible).toEqual([]);
    expect(slice.hiddenAbove).toBe(0);
  });

  it("respects multiline body length", () => {
    const longMsg = userMsg("u1", "line1\nline2\nline3\nline4\nline5");
    // 5 body + 3 overhead = 8 rows.
    expect(estimateMessageHeight(longMsg)).toBe(8);
    const slice = selectVisibleMessages(
      [longMsg, userMsg("u2", "tail")],
      0,
      6,
    );
    // The 5-line message would not fit in 6 rows alongside the
    // 4-row tail message, so only the tail remains and the long
    // one falls into hiddenAbove.
    expect(slice.visible.map((m) => m.id)).toEqual(["u2"]);
    expect(slice.hiddenAbove).toBe(1);
  });
});
