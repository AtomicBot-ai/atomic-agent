import { describe, expect, it, vi } from "vitest";

import type { ConversationTurn } from "../session/conversation-turn.js";
import {
  SIDE_QUESTION_MAX_INPUT_CHARS,
  SIDE_QUESTION_MAX_TOKENS,
  SIDE_QUESTION_SESSION_PREFIX,
  askSideQuestion,
  buildSideQuestionContext,
  extractSideAnswerText,
  type SideQuestionDeps,
} from "./side-question.js";

type Complete = SideQuestionDeps["complete"];

const turns: ConversationTurn[] = [
  { kind: "user", text: "refactor auth.ts", at: 1 },
  { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "auth.ts" }, at: 2 },
  { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "120 lines", at: 3 },
  { kind: "assistant_reply", text: "Split login() into two functions.", at: 4 },
];

describe("askSideQuestion (ATO-1152)", () => {
  it("asks under its own partition and budget, with the chat as context and no tools", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "auth.ts" }));
    const result = await askSideQuestion("which file?", {
      complete,
      slotId: () => 2,
      sessionId: "s-1",
      turns,
    });
    expect(result).toEqual({ ok: true, text: "auth.ts" });
    const params = complete.mock.calls[0]?.[0];
    if (params === undefined) throw new Error("expected a side-question request");
    expect(params.sessionId).toBe(`${SIDE_QUESTION_SESSION_PREFIX}s-1`);
    expect(params.slotId).toBe(2);
    expect(params.maxTokens).toBe(SIDE_QUESTION_MAX_TOKENS);
    expect(params.tools).toBeUndefined();
    expect(params.prompt).toContain("User: refactor auth.ts");
    expect(params.prompt).toContain("Agent: Split login() into two functions.");
    expect(params.prompt).toContain("which file?");
    expect(params.chat?.enableThinking).toBe(false);
  });

  it("never writes to the turns it was given", async () => {
    const copy = structuredClone(turns);
    await askSideQuestion("q", {
      complete: async () => ({ content: "a" }),
      slotId: () => 0,
      turns: copy,
    });
    expect(copy).toEqual(turns);
  });

  it("asks a cloud link through the sub-call request and reads the tool answer", async () => {
    const complete = vi.fn<Complete>(async () => ({
      content: "",
      toolCalls: [
        {
          id: "c1",
          type: "function" as const,
          function: { name: "emit_side_answer", arguments: JSON.stringify({ answer: "Yes." }) },
        },
      ],
    }));
    const result = await askSideQuestion("done?", {
      complete,
      slotId: () => 3,
      toolTransport: "native_tools",
    });
    expect(result).toEqual({ ok: true, text: "Yes." });
    expect(complete.mock.calls[0]?.[0]?.slotId).toBe(-1);
    expect(complete.mock.calls[0]?.[0]?.sessionId).toBe(`${SIDE_QUESTION_SESSION_PREFIX}draft`);
  });

  it("refuses an empty or oversized question without calling the model", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "x" }));
    expect((await askSideQuestion("  ", { complete, slotId: () => 0 })).ok).toBe(false);
    const long = "a".repeat(SIDE_QUESTION_MAX_INPUT_CHARS + 1);
    expect((await askSideQuestion(long, { complete, slotId: () => 0 })).ok).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports an empty answer and a model error as failures, never throws", async () => {
    const empty = await askSideQuestion("q", {
      complete: async () => ({ content: "<think>hmm</think>" }),
      slotId: () => 0,
    });
    expect(empty.ok).toBe(false);
    const failed = await askSideQuestion("q", {
      complete: async () => {
        throw new Error("boom");
      },
      slotId: () => 0,
    });
    expect(failed).toEqual({ ok: false, reason: "boom" });
  });

  it("times out and frees its pending controller", async () => {
    const pending = new Set<AbortController>();
    const result = await askSideQuestion("q", {
      complete: (params) =>
        new Promise((_resolve, reject) => {
          params.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      slotId: () => 0,
      pending,
      timeoutMs: 5,
    });
    expect(result).toEqual({ ok: false, reason: "timed out" });
    expect(pending.size).toBe(0);
  });
});

describe("buildSideQuestionContext", () => {
  it("keeps the newest rows that fit, oldest first", () => {
    const context = buildSideQuestionContext(turns, 60);
    expect(context).not.toContain("refactor auth.ts");
    expect(context.endsWith("Agent: Split login() into two functions.")).toBe(true);
  });

  it("is empty for a fresh chat", () => {
    expect(buildSideQuestionContext([])).toBe("");
  });
});

describe("extractSideAnswerText", () => {
  it("drops a reasoning block from a prose answer", () => {
    expect(extractSideAnswerText({ content: "<think>x</think> The answer." })).toBe("The answer.");
  });
});
