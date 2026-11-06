import { describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { StepEvent } from "../step-events.js";
import { appendBatchedTurns } from "./step-commit.js";

/**
 * ATO-967: the final `reply` is polished once, where it is committed, so
 * the recorded turn and the event every surface reads carry the same
 * text; the event keeps the raw text for consumers that streamed it.
 */
describe("appendBatchedTurns reply polish", () => {
  const raw = "Sure! The build passes.\n\n\n\nI hope this helps!";

  const commit = (replyPolish?: Parameters<typeof appendBatchedTurns>[0]["replyPolish"]) => {
    const events: StepEvent[] = [];
    const state = appendBatchedTurns({
      state: createEmptySessionState({ id: "reply-polish-fixture", workingDir: "/fixture" }),
      calls: [{ tool: "reply", args: { text: raw } }],
      results: [compressToolResult({ tool: "reply", status: "ok", output: raw })],
      reasoning: "",
      terminal: "turn",
      onEvent: (event) => events.push(event),
      ...(replyPolish !== undefined ? { replyPolish } : {}),
    });
    const turn = state.turns[state.turns.length - 1];
    const reply = events.find((e) => e.type === "assistant_reply");
    return { turn, reply };
  };

  it("records and emits the polished text, keeping the raw text on the event", () => {
    const { turn, reply } = commit({ channel: "tui", smallModel: true });
    expect(turn).toMatchObject({ kind: "assistant_reply", text: "The build passes." });
    expect(reply).toMatchObject({ type: "assistant_reply", text: "The build passes.", rawText: raw });
  });

  it("keeps the reply as written when no surface asked for the polish", () => {
    const { turn, reply } = commit();
    expect(turn).toMatchObject({ kind: "assistant_reply", text: raw });
    expect(reply).toMatchObject({ type: "assistant_reply", text: raw });
    expect(reply).not.toHaveProperty("rawText");
  });

  it("sets no raw text when the polish changed nothing", () => {
    const events: StepEvent[] = [];
    appendBatchedTurns({
      state: createEmptySessionState({ id: "reply-polish-clean", workingDir: "/fixture" }),
      calls: [{ tool: "reply", args: { text: "Done." } }],
      results: [compressToolResult({ tool: "reply", status: "ok", output: "Done." })],
      reasoning: "",
      terminal: "turn",
      onEvent: (event) => events.push(event),
      replyPolish: { channel: "telegram" },
    });
    const reply = events.find((e) => e.type === "assistant_reply");
    expect(reply).toMatchObject({ text: "Done." });
    expect(reply).not.toHaveProperty("rawText");
  });
});
