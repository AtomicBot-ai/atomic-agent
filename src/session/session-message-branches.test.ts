import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "./conversation-turn.js";
import {
  capBranches,
  foldStaleReplies,
  keepBranch,
  MESSAGE_BRANCHES_PER_QUESTION,
  MESSAGE_BRANCHES_TOTAL,
  readMessageBranches,
  type MessageBranch,
} from "./session-message-branches.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import { createEmptySessionState, incrementTurnCount, recordTurn, type SessionState } from "./session-state.js";
import { planLastTurnRollback, truncateSessionAt } from "./session-truncate.js";

const user = (text: string, at: number): ConversationTurn => ({ kind: "user", text, at });
const reply = (text: string, at: number): ConversationTurn => ({ kind: "assistant_reply", text, at });

function turn(state: SessionState, ...rows: ConversationTurn[]): SessionState {
  let next = state;
  for (const row of rows) next = recordTurn(next, row);
  return { ...incrementTurnCount(next), status: "completed" };
}

/** "A" → "a", "B" → "b", "C" → "c". */
function threeTurns(): SessionState {
  let state = createEmptySessionState({ id: "mb-1", workingDir: "/tmp" });
  state = turn(state, user("A", 1), reply("a", 2));
  state = turn(state, user("B", 3), reply("b", 4));
  return turn(state, user("C", 5), reply("c", 6));
}

const texts = (rows: readonly ConversationTurn[]) =>
  rows.map((row) => (row.kind === "user" || row.kind === "assistant_reply" ? row.text : row.kind));

function branch(priorQuestions: number, keptAt: number, text = "q"): MessageBranch {
  return { priorQuestions, turns: [user(text, keptAt)], turnEnds: [1], keptAt };
}

describe("keepBranch (ATO-2470)", () => {
  it("keeps the rows an edit cuts, with where each turn ended", () => {
    const before = threeTurns();
    const { state: cut } = truncateSessionAt(before, 2);
    const kept = keepBranch(before, 2, cut, 100);
    expect(texts(kept.turns)).toEqual(["A", "a"]);
    expect(kept.messageBranches).toHaveLength(1);
    const [b] = kept.messageBranches!;
    expect(b!.priorQuestions).toBe(1);
    expect(texts(b!.turns)).toEqual(["B", "b", "C", "c"]);
    expect(b!.turnEnds).toEqual([2, 4]);
    expect(b!.keptAt).toBe(100);
    // Without it the cut tail is simply gone.
    expect(cut.messageBranches).toBeUndefined();
  });

  it("nests the branches of later questions inside the new one and keeps siblings live", () => {
    let before = threeTurns();
    before = { ...before, messageBranches: [branch(1, 10, "B-old"), branch(2, 20, "C-old")] };
    const { state: cut } = truncateSessionAt(before, 2);
    const kept = keepBranch(before, 2, cut, 100);
    expect(kept.messageBranches!.map((b) => b.priorQuestions)).toEqual([1, 1]);
    const added = kept.messageBranches![1]!;
    expect(added.branches?.map((b) => b.turns[0]!.kind === "user" && b.turns[0]!.text)).toEqual(["C-old"]);
  });

  it("takes the tail's kept answers with it", () => {
    let state = turn(createEmptySessionState({ id: "mb-2", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    const { state: cut } = truncateSessionAt(state, 0);
    const kept = keepBranch(state, 0, cut, 100);
    expect(kept.previousReplies).toBeUndefined();
    expect(kept.messageBranches?.[0]?.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["a1"]);
  });

  it("does nothing for a cut that is not at a question", () => {
    const before = threeTurns();
    const { state: cut } = truncateSessionAt(before, 3);
    expect(keepBranch(before, 3, cut)).toBe(cut);
  });
});

describe("truncateSessionAt and branches (ATO-2470)", () => {
  it("drops the branches past the kept rows and keeps the ones they reach", () => {
    const state = { ...threeTurns(), messageBranches: [branch(0, 1), branch(1, 2), branch(2, 3)] };
    const { state: cut } = truncateSessionAt(state, 2);
    expect(cut.messageBranches?.map((b) => b.priorQuestions)).toEqual([0, 1]);
    expect(truncateSessionAt(state, 0).state.messageBranches?.map((b) => b.priorQuestions)).toEqual([0]);
  });
});

describe("foldStaleReplies (ATO-2470)", () => {
  it("turns answers kept for a question the chat moved past into branches of it", () => {
    let state = turn(createEmptySessionState({ id: "mb-3", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    const plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    expect(foldStaleReplies(state)).toBe(state);   // still the last question
    state = turn(state, user("B", 5), reply("b", 6));
    const folded = foldStaleReplies(state);
    expect(folded.previousReplies).toBeUndefined();
    expect(folded.messageBranches).toHaveLength(1);
    expect(texts(folded.messageBranches![0]!.turns)).toEqual(["A", "a1"]);
    expect(folded.messageBranches![0]!.priorQuestions).toBe(0);
  });

  it("a regenerate of a later question no longer drops the earlier question's kept answers", () => {
    let state = turn(createEmptySessionState({ id: "mb-4", workingDir: "/tmp" }), user("A", 1), reply("a1", 2));
    let plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    state = turn(plan.state, user("A", 3), reply("a2", 4));
    state = turn(state, user("B", 5), reply("b1", 6));
    plan = planLastTurnRollback(state);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.state.previousReplies?.prompt.text).toBe("B");
    expect(plan.state.messageBranches?.map((b) => texts(b.turns))).toEqual([["A", "a1"]]);
  });
});

describe("capBranches (ATO-2470)", () => {
  it("keeps at most the per-question cap, dropping the oldest", () => {
    const list = Array.from({ length: MESSAGE_BRANCHES_PER_QUESTION + 3 }, (_, i) => branch(0, i));
    const capped = capBranches(list);
    expect(capped).toHaveLength(MESSAGE_BRANCHES_PER_QUESTION);
    expect(capped[0]!.keptAt).toBe(3);
  });

  it("counts nested branches toward the chat's cap", () => {
    const heavy: MessageBranch = { ...branch(0, 0), branches: Array.from({ length: MESSAGE_BRANCHES_TOTAL }, (_, i) => branch(1, i)) };
    const capped = capBranches([heavy, branch(0, 99)]);
    expect(capped.map((b) => b.keptAt)).toEqual([99]);
  });

  it("drops the oldest when the text is too large", () => {
    const big = (keptAt: number): MessageBranch => ({ ...branch(0, keptAt), turns: [user("x".repeat(900_000), keptAt)] });
    expect(capBranches([big(1), big(2), big(3)]).map((b) => b.keptAt)).toEqual([2, 3]);
  });
});

describe("readMessageBranches (ATO-2470)", () => {
  it("keeps good entries, drops bad ones, and is applied on load", () => {
    const good = { priorQuestions: 0, turns: [user("A", 1), reply("a", 2)], keptAt: 5 };
    const read = readMessageBranches([good, { priorQuestions: -1, turns: [], keptAt: 1 }, "junk"]);
    expect(read).toHaveLength(1);
    expect(read![0]!.turnEnds).toEqual([2]);
    expect(readMessageBranches([{ priorQuestions: 0, turns: [reply("no question", 1)], keptAt: 1 }])).toBeUndefined();
    const loaded = normalizeSessionState({ ...createEmptySessionState({ id: "mb-5", workingDir: "/tmp" }), messageBranches: ["junk"] });
    expect(loaded.messageBranches).toBeUndefined();
    const kept = normalizeSessionState({ ...createEmptySessionState({ id: "mb-6", workingDir: "/tmp" }), messageBranches: [good] });
    expect(kept.messageBranches).toHaveLength(1);
  });
});
