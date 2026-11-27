import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "./conversation-turn.js";
import { keepBranch } from "./session-message-branches.js";
import { listMessageVersions, planSwitchVersion } from "./session-message-versions.js";
import { createEmptySessionState, incrementTurnCount, recordTurn, type SessionState } from "./session-state.js";
import { planLastTurnRollback, truncateSessionAt } from "./session-truncate.js";

const user = (text: string, at: number): ConversationTurn => ({ kind: "user", text, at });
const reply = (text: string, at: number): ConversationTurn => ({ kind: "assistant_reply", text, at });

function turn(state: SessionState, ...rows: ConversationTurn[]): SessionState {
  let next = state;
  for (const row of rows) next = recordTurn(next, row);
  return { ...incrementTurnCount(next), status: "completed" };
}

const texts = (rows: readonly ConversationTurn[]) =>
  rows.map((row) => (row.kind === "user" || row.kind === "assistant_reply" ? row.text : row.kind));

/** "A" → "a", "B" → "b", "C" → "c"; then "B" edited to "B2" and answered "b2". */
function edited(): { before: SessionState; after: SessionState } {
  let before = createEmptySessionState({ id: "mv-1", workingDir: "/tmp" });
  before = turn(before, user("A", 1), reply("a", 2));
  before = turn(before, user("B", 3), reply("b", 4));
  before = turn(before, user("C", 5), reply("c", 6));
  const { state: cut } = truncateSessionAt(before, 2);
  const after = turn(keepBranch(before, 2, cut, 50), user("B2", 7), reply("b2", 8));
  return { before, after };
}

describe("listMessageVersions (ATO-2470)", () => {
  it("lists the edited message with its live text and the kept one", () => {
    const { after } = edited();
    expect(listMessageVersions(after)).toEqual([
      {
        priorQuestions: 1,
        live: { text: "B2", at: 7, answerAt: 8 },
        versions: [{ ref: "b0", text: "B", at: 3, answerAt: 4, keptAt: 50 }],
        compacted: false,
      },
    ]);
  });

  it("lists answers Regenerate kept, for the last question and once the chat moved past it", () => {
    let state = turn(createEmptySessionState({ id: "mv-2", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    expect(listMessageVersions(state)[0]?.versions.map((v) => v.ref)).toEqual(["r0"]);
    state = turn(state, user("B", 5), reply("b", 6));
    const listed = listMessageVersions(state);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ priorQuestions: 0, live: { text: "A", answerAt: 4 } });
    expect(listed[0]!.versions).toEqual([{ ref: "b0", text: "A", at: 1, answerAt: 2, keptAt: expect.any(Number) }]);
  });

  it("lists nothing for a chat with no other version", () => {
    let state = createEmptySessionState({ id: "mv-3", workingDir: "/tmp" });
    state = turn(state, user("A", 1), reply("a", 2));
    expect(listMessageVersions(state)).toEqual([]);
  });
});

describe("planSwitchVersion (ATO-2470)", () => {
  it("puts the edited-away conversation back exactly, keeps the edit as a version, and leaves the prefix alone", () => {
    const { before, after } = edited();
    const plan = planSwitchVersion(after, { priorQuestions: 1, expectText: "B2", ref: "b0" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("B");
    expect(plan.state.turns).toEqual(before.turns);
    // The rows before the question are the very same objects (the cached prefix).
    expect(plan.state.turns.slice(0, 2)).toEqual(after.turns.slice(0, 2));
    expect(plan.state.turns[0]).toBe(after.turns[0]);
    expect(plan.state.turnCount).toBe(before.turnCount);
    expect(plan.state.macroTurnStarts).toEqual(before.macroTurnStarts);
    expect(plan.state.status).toBe("pending");
    expect(plan.versions).toBe(1);
    expect(texts(plan.state.messageBranches![0]!.turns)).toEqual(["B2", "b2"]);

    // And back to the edit.
    const back = planSwitchVersion(plan.state, { priorQuestions: 1, expectText: "B", ref: "b0" });
    expect(back.ok && texts(back.state.turns)).toEqual(["A", "a", "B2", "b2"]);
  });

  it("restores the later questions' versions that belonged to the switched-in branch", () => {
    let { after } = edited();
    // Edit "B2" again would nest; instead keep a version of question 2 inside the B branch:
    const b0 = after.messageBranches![0]!;
    after = { ...after, messageBranches: [{ ...b0, branches: [{ priorQuestions: 2, turns: [user("C-old", 9)], turnEnds: [1], keptAt: 9 }] }] };
    const plan = planSwitchVersion(after, { priorQuestions: 1, expectText: "B2", ref: "b0" });
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.state.messageBranches?.map((b) => b.priorQuestions).sort()).toEqual([1, 2]);
    expect(listMessageVersions(plan.state).map((q) => q.priorQuestions)).toEqual([1, 2]);
  });

  it("switches an earlier question to an answer Regenerate kept, keeping the rest as a version", () => {
    let state = turn(createEmptySessionState({ id: "mv-4", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const rolled = planLastTurnRollback(state);
    if (!rolled.ok) throw new Error(rolled.code);
    state = turn(rolled.state, user("A", 3), reply("a2", 4));
    state = turn(state, user("B", 5), reply("b", 6));
    const plan = planSwitchVersion(state, { priorQuestions: 0, expectText: "A", ref: "b0" });
    if (!plan.ok) throw new Error(plan.code);
    expect(texts(plan.state.turns)).toEqual(["A", "a1"]);
    expect(plan.state.messageBranches?.map((b) => texts(b.turns))).toEqual([["A", "a2", "B", "b"]]);
    expect(plan.state.turnCount).toBe(1);
    expect(plan.state.macroTurnStarts).toEqual([2]);
  });

  it("swaps the last question's kept answer through the regenerate rules", () => {
    let state = turn(createEmptySessionState({ id: "mv-5", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const rolled = planLastTurnRollback(state);
    if (!rolled.ok) throw new Error(rolled.code);
    state = turn(rolled.state, user("A", 3), reply("a2", 4));
    const plan = planSwitchVersion(state, { priorQuestions: 0, expectText: "A", ref: "r0" });
    expect(plan.ok && texts(plan.state.turns)).toEqual(["A", "a1"]);
    expect(plan.ok && plan.state.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["a2"]);
  });

  it("puts a kept version back over a regenerate whose new try never reached the store", () => {
    let state = turn(createEmptySessionState({ id: "mv-6", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const rolled = planLastTurnRollback(state);
    if (!rolled.ok) throw new Error(rolled.code);
    state = rolled.state;
    expect(listMessageVersions(state)).toEqual([
      { priorQuestions: 0, live: null, versions: [expect.objectContaining({ ref: "r0", text: "A" })], compacted: false },
    ]);
    const plan = planSwitchVersion(state, { priorQuestions: 0, expectText: "A", ref: "r0" });
    expect(plan.ok && texts(plan.state.turns)).toEqual(["A", "a1"]);
  });

  it("refuses a wrong question, an unknown ref, a running turn and a compacted point, changing nothing", () => {
    const { after } = edited();
    expect(planSwitchVersion(after, { priorQuestions: 1, expectText: "other", ref: "b0" })).toEqual({ ok: false, code: "point_mismatch" });
    expect(planSwitchVersion(after, { priorQuestions: 1, expectText: "B2", ref: "b7" })).toEqual({ ok: false, code: "no_version" });
    expect(planSwitchVersion(after, { priorQuestions: 0, expectText: "A", ref: "b0" })).toEqual({ ok: false, code: "no_version" });
    expect(planSwitchVersion({ ...after, status: "running" }, { priorQuestions: 1, ref: "b0" })).toEqual({ ok: false, code: "turn_in_progress" });
    const compacted = { ...after, compaction: { coveredThrough: 3 } as unknown as SessionState["compaction"] };
    expect(planSwitchVersion(compacted, { priorQuestions: 1, expectText: "B2", ref: "b0" })).toEqual({ ok: false, code: "point_compacted" });
  });
});
