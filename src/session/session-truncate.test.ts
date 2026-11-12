import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "./conversation-turn.js";
import { stoppedTurnMarker } from "./conversation-turn.js";
import { compactionBoundaryHash } from "./session-compaction.js";
import {
  createEmptySessionState,
  incrementTurnCount,
  recordTurn,
  type SessionState,
} from "./session-state.js";
import { planLastTurnRollback, truncateSessionAt } from "./session-truncate.js";

const user = (text: string, at: number, steered = false): ConversationTurn =>
  steered ? { kind: "user", text, steered: true, at } : { kind: "user", text, at };
const reply = (text: string, at: number): ConversationTurn => ({
  kind: "assistant_reply",
  text,
  at,
});
const call = (at: number): ConversationTurn => ({
  kind: "assistant_tool_call",
  tool: "os.fs.read",
  args: { path: "a.txt" },
  at,
});
const result = (at: number): ConversationTurn => ({
  kind: "tool_result",
  tool: "os.fs.read",
  status: "ok",
  summary: "ok",
  at,
});

/** Run `rows` as one turn the way the loop records it. */
function turn(state: SessionState, ...rows: ConversationTurn[]): SessionState {
  let next = state;
  for (const row of rows) next = recordTurn(next, row);
  return { ...incrementTurnCount(next), status: "completed" };
}

function fresh(): SessionState {
  return createEmptySessionState({ id: "s1", workingDir: "/tmp" });
}

describe("truncateSessionAt", () => {
  it("cuts two turns to one and the next turn gets the right boundary", () => {
    let state = turn(fresh(), user("hi", 1), reply("hello", 2));
    state = turn(state, user("again", 3), reply("sure", 4));
    expect(state.macroTurnStarts).toEqual([2, 4]);
    expect(state.turnCount).toBe(2);

    const { state: cut, compactionCovered } = truncateSessionAt(state, 2);
    expect(compactionCovered).toBe(false);
    expect(cut.turns).toHaveLength(2);
    expect(cut.turnCount).toBe(1);
    expect(cut.macroTurnStarts).toEqual([2]);

    const after = turn(cut, user("third", 5), reply("ok", 6));
    expect(after.macroTurnStarts).toEqual([2, 4]);
    expect(after.turnCount).toBe(2);
  });

  it("cuts a single turn down to an empty chat", () => {
    const state = turn(fresh(), user("hi", 1), reply("hello", 2));
    const { state: cut } = truncateSessionAt(state, 0);
    expect(cut.turns).toEqual([]);
    expect(cut.turnCount).toBe(0);
    expect(cut.macroTurnStarts).toEqual([]);
    expect(cut.status).toBe("pending");
  });

  it("returns the state unchanged when the cut is at the end", () => {
    const state = turn(fresh(), user("hi", 1), reply("hello", 2));
    expect(truncateSessionAt(state, 2).state).toBe(state);
  });

  it("counts cut prompts when no boundaries were recorded", () => {
    const state: SessionState = {
      ...fresh(),
      turns: [user("a", 1), reply("b", 2), user("c", 3), reply("d", 4)],
      turnCount: 2,
    };
    delete state.macroTurnStarts;
    const { state: cut } = truncateSessionAt(state, 2);
    expect(cut.turnCount).toBe(1);
    expect(cut.macroTurnStarts).toBeUndefined();
  });

  it("does not uncount a turn whose end was never recorded", () => {
    // The process died after the reply was checkpointed but before the
    // turn closed: two rows, no boundary, and the turn was never counted.
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = recordTurn(recordTurn(state, user("c", 3)), reply("d", 4));
    expect(state.turnCount).toBe(1);
    expect(state.macroTurnStarts).toEqual([2]);
    const { state: cut } = truncateSessionAt(state, 2);
    expect(cut.turnCount).toBe(1);
    expect(cut.macroTurnStarts).toEqual([2]);
  });

  it("leaves the chat waiting for its next message", () => {
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = { ...turn(state, user("c", 3)), status: "failed" };
    expect(truncateSessionAt(state, 2).state.status).toBe("pending");
  });

  it("drops a held pack start inside the cut part and keeps one before it", () => {
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = turn(state, user("c", 3), reply("d", 4));
    const inside = truncateSessionAt(
      { ...state, conversationPackStart: { index: 2, at: 3, boundBy: "pairs" } },
      2,
    ).state;
    expect(inside.conversationPackStart).toBeUndefined();
    const before = truncateSessionAt(
      { ...state, conversationPackStart: { index: 1, at: 2, boundBy: "tokens" } },
      2,
    ).state;
    expect(before.conversationPackStart).toEqual({ index: 1, at: 2, boundBy: "tokens" });
  });

  it("drops a rolling summary that reaches past the cut", () => {
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = turn(state, user("c", 3), reply("d", 4));
    const rolling = {
      version: 1 as const,
      summary: "s",
      from: 0,
      baseHash: "x",
      coveredThrough: 4,
      boundaryHash: "y",
      createdAt: 1,
      model: null,
    };
    expect(truncateSessionAt({ ...state, rollingSummary: rolling }, 2).state.rollingSummary)
      .toBeUndefined();
    expect(
      truncateSessionAt({ ...state, rollingSummary: { ...rolling, coveredThrough: 2 } }, 2)
        .state.rollingSummary,
    ).toBeDefined();
  });

  it("drops the context gauge and the last error", () => {
    const state = turn(fresh(), user("a", 1), reply("b", 2));
    const { state: cut } = truncateSessionAt(
      {
        ...state,
        lastError: "boom",
        contextUsage: { promptTokens: 5 } as unknown as SessionState["contextUsage"],
      },
      0,
    );
    expect(cut.contextUsage).toBeUndefined();
    expect(cut.lastError).toBeNull();
  });

  it("reports a compaction checkpoint over the cut part without touching it", () => {
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = turn(state, user("c", 3), reply("d", 4));
    const compaction = {
      version: 1 as const,
      summary: "s",
      coveredThrough: 4,
      boundaryHash: "h",
      createdAt: 1,
      reason: "manual",
      model: null,
      tokensBefore: 1,
      tokensAfter: 1,
    } as unknown as NonNullable<SessionState["compaction"]>;
    const covered = truncateSessionAt({ ...state, compaction }, 2);
    expect(covered.compactionCovered).toBe(true);
    expect(covered.state.compaction).toBe(compaction);
    const clear = truncateSessionAt(
      { ...state, compaction: { ...compaction, coveredThrough: 2 } },
      2,
    );
    expect(clear.compactionCovered).toBe(false);
  });

  it("cuts the cloud context back to the kept rows", () => {
    let state = turn(fresh(), user("a", 1), reply("b", 2));
    state = turn(state, user("c", 3), reply("d", 4));
    const entry = (i: number) => ({
      id: `turn:${i}`,
      through: i + 1,
      turn: { kind: "user" as const, text: String(i) },
    });
    const { state: cut } = truncateSessionAt(
      {
        ...state,
        cloudContext: {
          version: 1,
          turnsThrough: 4,
          boundaryHash: compactionBoundaryHash(state.turns[3]!),
          entries: [entry(0), entry(1), entry(2), entry(3)],
        },
      },
      2,
    );
    expect(cut.cloudContext?.turnsThrough).toBe(2);
    expect(cut.cloudContext?.boundaryHash).toBe(compactionBoundaryHash(state.turns[1]!));
    expect(cut.cloudContext?.entries.map((e) => e.id)).toEqual(["turn:0", "turn:1"]);
  });
});

describe("planLastTurnRollback", () => {
  it("takes back a plain question and answer and returns the question", () => {
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    state = turn(state, user("Hello", 3), reply("Hi!", 4));
    const plan = planLastTurnRollback(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("Hello");
    expect(plan.start).toBe(2);
    expect(plan.state.turns).toHaveLength(2);
    expect(plan.state.turnCount).toBe(1);
  });

  it("refuses a stopped turn: the stop may have cut a tool batch the transcript does not show", () => {
    // A local turn stopped during `rm` stores only [user, stop marker].
    const state = turn(fresh(), user("delete the build folder", 1), stoppedTurnMarker(2));
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_stopped" });
  });

  it("takes back a turn that has no answer at all (a provider error)", () => {
    const state = {
      ...turn(fresh(), user("hello", 1)),
      status: "failed" as const,
      lastError: "402",
    };
    const plan = planLastTurnRollback(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.state.turns).toEqual([]);
    expect(plan.state.lastError).toBeNull();
    expect(plan.state.status).toBe("pending");
  });

  it("refuses a turn that ran a tool", () => {
    const state = turn(fresh(), user("read it", 1), call(2), result(3), reply("done", 4));
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_has_tools" });
  });

  it("refuses a turn with a progress note", () => {
    const state = turn(fresh(), user("go", 1), {
      kind: "assistant_reply",
      text: "on it",
      progressNote: true,
      at: 2,
    });
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_has_tools" });
  });

  it("refuses a reply that delivered files", () => {
    const state = turn(fresh(), user("make it", 1), {
      kind: "assistant_reply",
      text: "here",
      attachments: ["/tmp/a.png"],
      at: 2,
    });
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_has_tools" });
  });

  it("refuses a steered turn", () => {
    const state = turn(fresh(), user("a", 1), user("also b", 2, true), reply("c", 3));
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_steered" });
  });

  it("refuses a compacted turn", () => {
    const state = {
      ...turn(fresh(), user("a", 1), reply("b", 2)),
      compaction: { coveredThrough: 2 } as unknown as NonNullable<SessionState["compaction"]>,
    };
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_compacted" });
  });

  it("refuses an empty chat and a running one", () => {
    expect(planLastTurnRollback(fresh())).toEqual({ ok: false, code: "nothing_to_undo" });
    const running = { ...turn(fresh(), user("a", 1), reply("b", 2)), status: "running" as const };
    expect(planLastTurnRollback(running)).toEqual({ ok: false, code: "turn_in_progress" });
  });

  it("refuses when the last question is not the one the caller meant", () => {
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    // A failed second turn the agent never recorded: its last question is still "first".
    expect(planLastTurnRollback(state, { expectText: "second" }))
      .toEqual({ ok: false, code: "turn_mismatch" });
    state = turn(state, user("second", 3), reply("two", 4));
    expect(planLastTurnRollback(state, { expectText: "  second\n" }).ok).toBe(true);
  });

  it("tells two questions with the same text apart by their position", () => {
    // q0 "continue" answered; q1 "continue" failed and was never stored.
    const state = turn(fresh(), user("continue", 1), reply("a0", 2));
    expect(planLastTurnRollback(state, { expectText: "continue", expectPriorQuestions: 1 }))
      .toEqual({ ok: false, code: "turn_mismatch" });
    expect(planLastTurnRollback(state, { expectText: "continue", expectPriorQuestions: 0 }).ok)
      .toBe(true);
  });

  it("does not count steers as questions before the one meant", () => {
    let state = turn(fresh(), user("a", 1), user("also", 2, true), reply("b", 3));
    state = turn(state, user("c", 4), reply("d", 5));
    expect(planLastTurnRollback(state, { expectPriorQuestions: 1 }).ok).toBe(true);
  });

  it("never removes a real answer for a failed question on screen, after a cleared transcript (ATO-1420)", () => {
    // "first" answered, then the window was cleared (the agent keeps it);
    // "continue" answered; a second "continue" failed and was never stored.
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    state = turn(state, user("continue", 3), reply("real answer", 4));
    // The window counts one question before the failed one (the cleared
    // "first" is not on screen), which is the stored "continue"'s position.
    const counted = { expectText: "continue", expectPriorQuestions: 1 };
    expect(planLastTurnRollback(state, counted).ok).toBe(true);
    // The window saw no answer to the failed one: the stored "continue" is not it.
    expect(planLastTurnRollback(state, { ...counted, expectUnanswered: true }))
      .toEqual({ ok: false, code: "turn_mismatch" });
    expect(state.turns.map((t) => t.kind === "assistant_reply" && t.text)).toContain("real answer");
  });

  it("still takes back a failed question that has no answer when expectUnanswered is set", () => {
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    state = { ...turn(state, user("continue", 3)), status: "failed" as const, lastError: "402" };
    const plan = planLastTurnRollback(state, {
      expectText: "continue",
      expectPriorQuestions: 1,
      expectUnanswered: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.state.turns).toHaveLength(2);
  });

  it("keeps the stop refusal for a stopped turn when expectUnanswered is set", () => {
    const state = turn(fresh(), user("delete the build folder", 1), stoppedTurnMarker(2));
    expect(planLastTurnRollback(state, { expectUnanswered: true }))
      .toEqual({ ok: false, code: "turn_stopped" });
  });

  it("refuses two answers after one prompt", () => {
    const state = turn(fresh(), user("a", 1), reply("b", 2), reply("c", 3));
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_unrecognized" });
  });
});
