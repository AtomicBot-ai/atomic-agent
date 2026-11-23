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
import {
  listPreviousReplies,
  planLastTurnRollback,
  planRestorePreviousReply,
  truncateSessionAt,
} from "./session-truncate.js";
import { PREVIOUS_REPLIES_CAP, readPreviousReplies } from "./session-previous-replies.js";

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

  it("never takes back a failed turn whose tools already ran (ATO-1476)", () => {
    // The step that ran the tool failed before it was stored: no tool row,
    // only the failure record, marked.
    const failedRecord: ConversationTurn = {
      kind: "assistant_reply",
      text: "(this turn failed before it could answer — transport: reset. Before it failed, these tools had already run: os.fs.delete. Their effects stay.)",
      toolsRan: true,
      at: 2,
    };
    const state = { ...turn(fresh(), user("delete the build folder", 1), failedRecord), status: "failed" as const };
    expect(planLastTurnRollback(state)).toEqual({ ok: false, code: "turn_has_tools" });
    // The same record without the mark is a plain failed answer.
    const plain = { ...turn(fresh(), user("hi", 1), reply("(this turn failed before it could answer — transport: reset. Nothing from it took effect.)", 2)), status: "failed" as const };
    expect(planLastTurnRollback(plain).ok).toBe(true);
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

describe("previous replies kept by a regenerate (ATO-864)", () => {
  it("keeps the answer taken back beside the transcript, not in it", () => {
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    state = turn(state, user("Hello", 3), reply("Hi!", 4));
    const plan = planLastTurnRollback(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.previousReplies).toBe(1);
    expect(plan.state.turns.map((t) => t.kind)).toEqual(["user", "assistant_reply"]);
    expect(plan.state.previousReplies?.priorQuestions).toBe(1);
    expect(plan.state.previousReplies?.prompt.text).toBe("Hello");
    expect(plan.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["Hi!"]);
  });

  it("does not keep a failed turn's record, a stop marker or a reply with files", () => {
    const failed = {
      ...turn(fresh(), user("hello", 1), reply("(this turn failed before it could answer — x: y. Nothing from it took effect.)", 2)),
      status: "failed" as const,
    };
    const plan = planLastTurnRollback(failed);
    expect(plan.ok && plan.previousReplies).toBe(0);
    expect(plan.ok && plan.state.previousReplies).toBeUndefined();

    const noAnswer = { ...turn(fresh(), user("hello", 1)), status: "failed" as const };
    const none = planLastTurnRollback(noAnswer);
    expect(none.ok && none.state.previousReplies).toBeUndefined();
  });

  it("collects every try of the same question and caps the list", () => {
    let state = turn(fresh(), user("Hello", 1), reply("try 0", 2));
    for (let i = 1; i <= 12; i += 1) {
      const plan = planLastTurnRollback(state);
      if (!plan.ok) throw new Error(plan.code);
      state = turn(plan.state, user("Hello", 10 + i), reply(`try ${i}`, 20 + i));
    }
    const replies = state.previousReplies?.replies.map((r) => r.reply.text) ?? [];
    expect(replies).toHaveLength(PREVIOUS_REPLIES_CAP);
    expect(replies[replies.length - 1]).toBe("try 11");
    expect(replies).not.toContain("try 12");
  });

  it("replaces the record when another question is regenerated", () => {
    let state = turn(fresh(), user("A", 1), reply("a1", 2));
    let plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    state = turn(state, user("B", 5), reply("b1", 6));
    plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.state.previousReplies?.prompt.text).toBe("B");
    expect(plan.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["b1"]);
  });

  it("a cut further back than the kept question drops the kept answers", () => {
    let state = turn(fresh(), user("A", 1), reply("a", 2));
    state = turn(state, user("B", 3), reply("b1", 4));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.state.previousReplies).toBeDefined();
    expect(truncateSessionAt(plan.state, 0).state.previousReplies).toBeUndefined();
    // A cut at the kept question's own place keeps them.
    expect(truncateSessionAt(plan.state, 2).state.previousReplies).toBeDefined();
  });

  it("lists nothing once the chat moved past the question", () => {
    let state = turn(fresh(), user("A", 1), reply("a1", 2));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    expect(listPreviousReplies(plan.state)).toMatchObject({ question: "A", questionStored: false });
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    expect(listPreviousReplies(state)).toMatchObject({ question: "A", questionStored: true });
    state = turn(state, user("next", 5), reply("n", 6));
    expect(listPreviousReplies(state).replies).toEqual([]);
    expect(planRestorePreviousReply(state)).toEqual({ ok: false, code: "no_previous_reply" });
    // Same position, different text: not the kept question either.
    const other = turn(plan.state, user("something else", 3), reply("x", 4));
    expect(listPreviousReplies(other).replies).toEqual([]);
  });
});

describe("planRestorePreviousReply (ATO-864)", () => {
  /** "first" answered, then "Hello" answered "old", regenerated to `newRows`. */
  function regenerated(...newRows: ConversationTurn[]): SessionState {
    let state = turn(fresh(), user("first", 1), reply("one", 2));
    state = turn(state, user("Hello", 3), reply("old", 4));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    return newRows.length === 0 ? plan.state : turn(plan.state, user("Hello", 5), ...newRows);
  }

  it("swaps the new answer for the old one and keeps the new one in turn", () => {
    const state = regenerated(reply("new", 6));
    const plan = planRestorePreviousReply(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("old");
    expect(plan.previousReplies).toBe(1);
    const rows = plan.state.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind));
    expect(rows).toEqual(["first", "one", "Hello", "old"]);
    expect(plan.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["new"]);
    // Every counter as if "old" had been the only answer.
    expect(plan.state.turnCount).toBe(2);
    expect(plan.state.macroTurnStarts).toEqual([2, 4]);
    expect(plan.state.status).toBe("pending");
    expect(plan.state.lastError).toBeNull();
    expect(plan.state.contextUsage).toBeUndefined();
    // And back again.
    const again = planRestorePreviousReply(plan.state);
    expect(again.ok && again.text).toBe("new");
    expect(again.ok && again.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["old"]);
  });

  it("puts the old answer back over a new try that failed, and drops the failure record", () => {
    const state = {
      ...regenerated(reply("(this turn failed before it could answer — net: down. Nothing from it took effect.)", 6)),
      status: "failed" as const,
      lastError: "network",
    };
    const plan = planRestorePreviousReply(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.state.turns.map((t) => t.kind === "assistant_reply" && t.text)).toContain("old");
    expect(plan.state.turns).toHaveLength(4);
    expect(plan.state.previousReplies).toBeUndefined();
    expect(plan.previousReplies).toBe(0);
    expect(plan.state.status).toBe("pending");
    expect(plan.state.lastError).toBeNull();
    expect(plan.state.turnCount).toBe(2);
    expect(plan.state.macroTurnStarts).toEqual([2, 4]);
  });

  it("puts the question back too when the new try never reached the store", () => {
    const state = regenerated();
    expect(state.turns).toHaveLength(2);
    const plan = planRestorePreviousReply(state);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const rows = plan.state.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind));
    expect(rows).toEqual(["first", "one", "Hello", "old"]);
    expect(plan.state.turnCount).toBe(2);
    expect(plan.state.macroTurnStarts).toEqual([2, 4]);
  });

  it("refuses to swap out a new answer that ran tools", () => {
    const state = regenerated(call(6), result(7), reply("done", 8));
    expect(planRestorePreviousReply(state)).toEqual({ ok: false, code: "turn_has_tools" });
  });

  it("refuses a stopped new try, a running chat and a bad index", () => {
    expect(planRestorePreviousReply(regenerated(stoppedTurnMarker(6)))).toEqual({ ok: false, code: "turn_stopped" });
    expect(planRestorePreviousReply({ ...regenerated(reply("new", 6)), status: "running" }))
      .toEqual({ ok: false, code: "turn_in_progress" });
    expect(planRestorePreviousReply(regenerated(reply("new", 6)), 3)).toEqual({ ok: false, code: "bad_index" });
    expect(planRestorePreviousReply(fresh())).toEqual({ ok: false, code: "no_previous_reply" });
  });

  it("refuses when the new try was compacted", () => {
    const state = regenerated(reply("new", 6));
    const compacted = {
      ...state,
      compaction: { coveredThrough: 4 } as unknown as NonNullable<SessionState["compaction"]>,
    };
    expect(planRestorePreviousReply(compacted)).toEqual({ ok: false, code: "turn_compacted" });
  });

  it("drops the packer cut, the rolling summary and the cloud mirror past the swapped turn", () => {
    const base = regenerated(reply("new", 6));
    const state: SessionState = {
      ...base,
      conversationPackStart: { index: 2, at: 1, boundBy: "tokens" },
      rollingSummary: { coveredThrough: 4 } as unknown as NonNullable<SessionState["rollingSummary"]>,
    };
    const plan = planRestorePreviousReply(state);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.state.conversationPackStart).toBeUndefined();
    expect(plan.state.rollingSummary).toBeUndefined();
  });

  it("picks a given earlier answer by index", () => {
    let state = regenerated(reply("second", 6));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("Hello", 7), reply("third", 8));
    expect(listPreviousReplies(state).replies.map((r) => r.reply.text)).toEqual(["old", "second"]);
    const restored = planRestorePreviousReply(state, 0);
    if (!restored.ok) throw new Error(restored.code);
    expect(restored.text).toBe("old");
    expect(restored.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["second", "third"]);
  });
});

describe("readPreviousReplies (ATO-864)", () => {
  it("drops a malformed record and keeps a good one", () => {
    expect(readPreviousReplies(null)).toBeUndefined();
    expect(readPreviousReplies({ prompt: { kind: "user", text: "x", at: 1 }, priorQuestions: -1, replies: [] })).toBeUndefined();
    expect(readPreviousReplies({ prompt: { kind: "user", text: "x", at: 1 }, priorQuestions: 0, replies: [{ nope: 1 }] })).toBeUndefined();
    const good = readPreviousReplies({
      prompt: { kind: "user", text: "x", at: 1 },
      priorQuestions: 0,
      replies: [{ reply: { kind: "assistant_reply", text: "y", at: 2 }, replacedAt: 3 }],
    });
    expect(good?.replies).toHaveLength(1);
  });
});
