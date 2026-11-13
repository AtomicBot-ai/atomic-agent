import { describe, expect, it, vi } from "vitest";

import { stoppedTurnMarker } from "./conversation-turn.js";
import { createEmptySessionState } from "./session-state.js";
import type { SessionState } from "./session-state.js";
import {
  NEXT_STEP_MAX_CHARS,
  NEXT_STEP_MAX_TOKENS,
  NEXT_STEP_SESSION_PREFIX,
  SESSION_NEXT_STEP_METADATA_KEY,
  buildNextStepPrompt,
  extractNextStepText,
  generateNextStep,
  lastExchangeOf,
  readSessionNextStep,
  sanitizeNextStep,
  shouldSuggestNextStep,
  type NextStepDeps,
} from "./session-next-step.js";

function session(
  turns: SessionState["turns"],
  extra: Partial<SessionState> = {},
): SessionState {
  const base = createEmptySessionState({ id: "s-1", workingDir: "/w" });
  return { ...base, turns, ...extra };
}

const ASKED = { kind: "user", text: "write a parser for the csv export", at: 1 } as const;
const ANSWERED = { kind: "assistant_reply", text: "Done: parser.ts reads the export.", at: 2 } as const;

describe("readSessionNextStep", () => {
  const stamp = (afterTurn: number, text = "Add tests for the parser") => ({
    [SESSION_NEXT_STEP_METADATA_KEY]: { text, afterTurn, at: 5 },
  });

  it("shows a suggestion made for the turn the session is at", () => {
    expect(readSessionNextStep({ metadata: stamp(3), turnCount: 3, status: "pending" }))
      .toBe("Add tests for the parser");
  });

  it("hides a suggestion a later turn made stale, and any while a turn runs", () => {
    expect(readSessionNextStep({ metadata: stamp(2), turnCount: 3, status: "pending" })).toBeNull();
    expect(readSessionNextStep({ metadata: stamp(3), turnCount: 3, status: "running" })).toBeNull();
    expect(readSessionNextStep({ metadata: stamp(3), turnCount: 3, status: "awaiting_approval" })).toBeNull();
  });

  it("reads nothing out of a missing or malformed stamp", () => {
    expect(readSessionNextStep({ metadata: {}, turnCount: 1, status: "pending" })).toBeNull();
    expect(readSessionNextStep({ metadata: { nextStep: "text" }, turnCount: 1, status: "pending" })).toBeNull();
    expect(readSessionNextStep({ metadata: stamp(1, "   "), turnCount: 1, status: "pending" })).toBeNull();
  });
});

describe("shouldSuggestNextStep", () => {
  it("is true after an answered turn", () => {
    expect(shouldSuggestNextStep(session([ASKED, ANSWERED]))).toBe(true);
  });

  it("is false after a stop, a progress note, or no answer", () => {
    expect(shouldSuggestNextStep(session([ASKED, stoppedTurnMarker(2)]))).toBe(false);
    expect(shouldSuggestNextStep(session([ASKED, { ...ANSWERED, progressNote: true }]))).toBe(false);
    expect(shouldSuggestNextStep(session([ASKED]))).toBe(false);
    expect(shouldSuggestNextStep(session([ASKED, { ...ANSWERED, text: "  " }]))).toBe(false);
  });
});

describe("lastExchangeOf", () => {
  it("pairs the last reply with the request before it", () => {
    const state = session([
      { kind: "user", text: "old", at: 0 },
      { kind: "assistant_reply", text: "old answer", at: 0 },
      ASKED,
      ANSWERED,
    ]);
    expect(lastExchangeOf(state)).toEqual({
      request: ASKED.text,
      reply: ANSWERED.text,
    });
  });
});

describe("sanitizeNextStep", () => {
  it("keeps one clean line", () => {
    expect(sanitizeNextStep('"Add tests for the parser"')).toBe("Add tests for the parser");
    expect(sanitizeNextStep("Next step: run it on the real file\nBecause…")).toBe(
      "run it on the real file",
    );
    expect(sanitizeNextStep("<think>hmm</think>Добавь тесты")).toBe("Добавь тесты");
    expect(sanitizeNextStep("- *Ship it*")).toBe("Ship it");
  });

  it("reads NONE and empty answers as no suggestion", () => {
    expect(sanitizeNextStep("NONE")).toBeNull();
    expect(sanitizeNextStep("none.")).toBeNull();
    expect(sanitizeNextStep("<think>only thinking")).toBeNull();
    expect(sanitizeNextStep("")).toBeNull();
  });

  it("bounds the length", () => {
    const out = sanitizeNextStep("x".repeat(500));
    expect(out?.length).toBe(NEXT_STEP_MAX_CHARS);
    expect(out?.endsWith("…")).toBe(true);
  });
});

describe("extractNextStepText", () => {
  it("reads the emit tool first and prose otherwise", () => {
    expect(extractNextStepText({
      content: "",
      toolCalls: [{ id: "1", type: "function", function: { name: "emit_next_step", arguments: '{"next":"Ship it"}' } }],
    } as never)).toBe("Ship it");
    expect(extractNextStepText({ content: "Ship it" })).toBe("Ship it");
  });
});

describe("generateNextStep", () => {
  const state = session([ASKED, ANSWERED]);

  it("asks a grammar link through the chat template, bounded and off the turn's partition", async () => {
    const complete = vi.fn<NextStepDeps["complete"]>(async () => ({ content: "Add tests for the parser" }));
    const text = await generateNextStep(state, { complete, slotId: () => 4 });
    expect(text).toBe("Add tests for the parser");
    const request = complete.mock.calls[0]![0];
    expect(request.sessionId).toBe(`${NEXT_STEP_SESSION_PREFIX}s-1`);
    expect(request.maxTokens).toBe(NEXT_STEP_MAX_TOKENS);
    expect(request.slotId).toBe(4);
    expect(request.chat?.enableThinking).toBe(false);
    expect(request.prompt).toBe(buildNextStepPrompt(ASKED.text, ANSWERED.text));
  });

  it("asks a cloud link through an emit tool", async () => {
    const complete = vi.fn<NextStepDeps["complete"]>(async () => ({
      content: "",
      toolCalls: [{ id: "1", type: "function", function: { name: "emit_next_step", arguments: '{"next":"Ship it"}' } }],
    } as never));
    const text = await generateNextStep(state, { complete, slotId: () => 4, toolTransport: "native_tools" });
    expect(text).toBe("Ship it");
    const request = complete.mock.calls[0]![0];
    expect(request.slotId).toBe(-1);
    expect(request.maxTokens).toBe(NEXT_STEP_MAX_TOKENS);
    expect(request.tools?.[0]?.function.name).toBe("emit_next_step");
  });

  it("returns null and reports, never throws, when the call fails", async () => {
    const onError = vi.fn();
    const text = await generateNextStep(state, {
      complete: async () => { throw new Error("refused"); },
      slotId: () => 0,
      onError,
    });
    expect(text).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("makes no call when there is no answered exchange", async () => {
    const complete = vi.fn<NextStepDeps["complete"]>();
    expect(await generateNextStep(session([ASKED]), { complete, slotId: () => 0 })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
