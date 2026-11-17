import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "./conversation-turn.js";
import { createEmptySessionState, type SessionState } from "./session-state.js";
import { forkTitle, planFork, questionRowIndex, questionTurnEnd } from "./session-fork.js";

const user = (text: string, at: number, steered = false): ConversationTurn =>
  steered ? { kind: "user", text, steered: true, at } : { kind: "user", text, at };
const reply = (text: string, at: number): ConversationTurn => ({ kind: "assistant_reply", text, at });

/** q0 (0,1) · q1 with a steer (2..4) · q2 (5,6). */
function chat(metadata: Record<string, unknown> = {}): SessionState {
  return {
    ...createEmptySessionState({ id: "s-src", workingDir: "/tmp/w", metadata }),
    status: "completed",
    turns: [
      user("first", 1),
      reply("one", 2),
      user("second", 3),
      user("and this", 4, true),
      reply("two", 5),
      user("third", 6),
      reply("three", 7),
    ],
    turnCount: 3,
    macroTurnStarts: [2, 5, 7],
    sessionUsage: { costUsd: 1 } as never,
  };
}

describe("questionRowIndex / questionTurnEnd (ATO-1058)", () => {
  it("finds a question by how many come before it, steers not counted", () => {
    const state = chat();
    expect(questionRowIndex(state, 0)).toBe(0);
    expect(questionRowIndex(state, 1)).toBe(2);
    expect(questionRowIndex(state, 2)).toBe(5);
    expect(questionRowIndex(state, 3)).toBe(-1);
    expect(questionTurnEnd(state, 2)).toBe(5);
    expect(questionTurnEnd(state, 5)).toBe(7);
  });
});

describe("planFork (ATO-1058)", () => {
  it("copies the history through that question's answer into a new chat", () => {
    const plan = planFork(chat({ title: "Trip plan", webhookName: "hook", llm: { providerId: "p" } }), {
      priorQuestions: 1,
      expectText: " second ",
      now: 50,
      newId: () => "s-fork",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.state.id).toBe("s-fork");
    expect(plan.state.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind))).toEqual([
      "first", "one", "second", "and this", "two",
    ]);
    expect(plan.state.turnCount).toBe(2);
    expect(plan.state.macroTurnStarts).toEqual([2, 5]);
    expect(plan.title).toBe("Trip plan (fork)");
    expect(plan.state.metadata.title).toBe("Trip plan (fork)");
    expect(plan.state.metadata.forkedFrom).toEqual({ sessionId: "s-src", turnIndex: 2, at: 50 });
    expect(plan.state.metadata.webhookName).toBeUndefined();
    expect(plan.state.metadata.llm).toEqual({ providerId: "p" });
    expect(plan.state.sessionUsage).toBeUndefined();
    expect(plan.state.createdAt).toBe(50);
  });

  it("keeps the whole chat when the last question is picked", () => {
    const plan = planFork(chat(), { priorQuestions: 2, expectText: "third", newId: () => "s-f2" });
    expect(plan.ok && plan.state.turns.length).toBe(7);
  });

  it("refuses a question that is not the one given", () => {
    expect(planFork(chat(), { priorQuestions: 1, expectText: "first" })).toEqual({ ok: false, code: "point_mismatch" });
    expect(planFork(chat(), { priorQuestions: 9 })).toEqual({ ok: false, code: "point_mismatch" });
  });

  it("refuses while a turn runs and inside a compacted part", () => {
    expect(planFork({ ...chat(), status: "running" }, { priorQuestions: 0 })).toEqual({ ok: false, code: "turn_in_progress" });
    const compacted = { ...chat(), compaction: { coveredThrough: 6 } as never };
    expect(planFork(compacted, { priorQuestions: 0 })).toEqual({ ok: false, code: "point_compacted" });
  });
});

describe("forkTitle", () => {
  it("names an untitled chat after its first question and keeps the title short", () => {
    expect(forkTitle(chat())).toBe("first (fork)");
    const long = forkTitle(chat({ title: "x".repeat(80) }));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("… (fork)")).toBe(true);
  });
});
