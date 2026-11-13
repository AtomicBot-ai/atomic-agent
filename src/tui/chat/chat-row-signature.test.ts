import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../tui-state.js";
import { chatRowSignature, chatRowSignatures } from "./chat-row-signature.js";

const reply: ChatMessage = {
  id: "a1",
  role: "assistant",
  text: "done.",
  toolSteps: 1,
  toolCards: [
    {
      id: "tc1",
      stepIndex: 0,
      tool: "os.fs.read",
      args: { path: "/tmp/a.txt" },
      status: "ok",
      summary: "read /tmp/a.txt",
      truncated: false,
      startedAt: 0,
      finishedAt: 1,
    },
  ],
  timestamp: 1,
};

const base = {
  fold: "closed" as const,
  fusion: false,
  toolsExpandedById: {},
  planHandoff: false,
};

describe("chatRowSignature", () => {
  it("changes when a card of the message is expanded or its turn opens", () => {
    const closed = chatRowSignature(reply, base);
    expect(
      chatRowSignature(reply, { ...base, toolsExpandedById: { tc1: true } }),
    ).not.toBe(closed);
    expect(chatRowSignature(reply, { ...base, fold: "open" })).not.toBe(closed);
  });

  it("ignores cards that belong to other messages", () => {
    expect(
      chatRowSignature(reply, { ...base, toolsExpandedById: { other: true } }),
    ).toBe(chatRowSignature(reply, base));
  });
});

describe("chatRowSignatures", () => {
  const user: ChatMessage = { id: "u1", role: "user", text: "go", timestamp: 0 };
  const signatures = chatRowSignatures({
    messages: [user, reply],
    columns: 80,
    foldOf: () => "none",
    fusion: false,
    toolsExpandedById: {},
    planButtons: true,
  });

  it("carries the width apart from the render signature", () => {
    expect(signatures("u1").columns).toBe(80);
    expect(signatures("not-a-message")).toEqual({ columns: 80, render: "" });
  });

  it("puts the plan buttons only on the newest assistant message", () => {
    expect(signatures("a1").render).toContain("|p|");
    expect(signatures("u1").render).not.toContain("|p|");
  });
});
