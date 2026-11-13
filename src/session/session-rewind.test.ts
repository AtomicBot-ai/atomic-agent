import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "./conversation-turn.js";
import {
  createEmptySessionState,
  incrementTurnCount,
  recordTurn,
  type SessionState,
} from "./session-state.js";
import { listRewindPoints, planRewind, rewindPreview } from "./session-rewind.js";

const user = (text: string, at: number, steered = false): ConversationTurn =>
  steered ? { kind: "user", text, steered: true, at } : { kind: "user", text, at };
const reply = (text: string, at: number): ConversationTurn => ({
  kind: "assistant_reply",
  text,
  at,
});
const call = (at: number): ConversationTurn => ({
  kind: "assistant_tool_call",
  tool: "os.fs.write",
  args: { path: "a.txt" },
  at,
});
const result = (at: number): ConversationTurn => ({
  kind: "tool_result",
  tool: "os.fs.write",
  status: "ok",
  summary: "ok",
  at,
});

function turn(state: SessionState, ...rows: ConversationTurn[]): SessionState {
  let next = state;
  for (const row of rows) next = recordTurn(next, row);
  return { ...incrementTurnCount(next), status: "completed" };
}

/** first (0,1) · second with a tool and a steer (2..6) · third (7,8). */
function threeTurns(): SessionState {
  let state = createEmptySessionState({ id: "s1", workingDir: "/tmp" });
  state = turn(state, user("first", 1), reply("one", 2));
  state = turn(
    state,
    user("second", 3),
    call(4),
    user("and also this", 5, true),
    result(6),
    reply("two", 7),
  );
  state = turn(state, user("third", 8), reply("three", 9));
  return state;
}

describe("listRewindPoints", () => {
  it("lists the questions newest first and leaves steers out", () => {
    const points = listRewindPoints(threeTurns());
    expect(points.map((p) => [p.text, p.turnIndex, p.ordinal])).toEqual([
      ["third", 7, 3],
      ["second", 2, 2],
      ["first", 0, 1],
    ]);
  });

  it("is empty for a chat with no questions", () => {
    expect(listRewindPoints(createEmptySessionState({ id: "s", workingDir: "/tmp" }))).toEqual([]);
  });

  it("leaves out the questions a compaction checkpoint covers", () => {
    const state = threeTurns();
    const compacted = {
      ...state,
      compaction: { ...({} as NonNullable<SessionState["compaction"]>), coveredThrough: 3 },
    } as SessionState;
    expect(listRewindPoints(compacted).map((p) => p.text)).toEqual(["third"]);
  });
});

describe("planRewind", () => {
  it("drops the picked question and everything after it, tools included", () => {
    const plan = planRewind(threeTurns(), 2, "second");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("second");
    expect(plan.state.turns).toHaveLength(2);
    expect(plan.state.turnCount).toBe(1);
    expect(plan.state.status).toBe("pending");
  });

  it("can go back to before the first question", () => {
    const plan = planRewind(threeTurns(), 0, "first");
    expect(plan.ok && plan.state.turns).toEqual([]);
    expect(plan.ok && plan.state.turnCount).toBe(0);
  });

  it("refuses while a turn runs", () => {
    const running = { ...threeTurns(), status: "running" } as SessionState;
    expect(planRewind(running, 2, "second")).toEqual({ ok: false, code: "turn_in_progress" });
  });

  it("refuses a row that is not the question the picker showed", () => {
    const state = threeTurns();
    expect(planRewind(state, 2, "something else")).toEqual({ ok: false, code: "point_mismatch" });
    // A reply, a steer, and an index past the end.
    expect(planRewind(state, 1)).toEqual({ ok: false, code: "point_mismatch" });
    expect(planRewind(state, 4)).toEqual({ ok: false, code: "point_mismatch" });
    expect(planRewind(state, 99)).toEqual({ ok: false, code: "point_mismatch" });
  });

  it("refuses a point inside the compacted part", () => {
    const state = threeTurns();
    const compacted = {
      ...state,
      compaction: { ...({} as NonNullable<SessionState["compaction"]>), coveredThrough: 3 },
    } as SessionState;
    expect(planRewind(compacted, 2, "second")).toEqual({ ok: false, code: "point_compacted" });
    expect(planRewind(compacted, 7, "third").ok).toBe(true);
  });

  it("says there is nothing to rewind in an empty chat", () => {
    const empty = createEmptySessionState({ id: "s", workingDir: "/tmp" });
    expect(planRewind(empty, 0)).toEqual({ ok: false, code: "nothing_to_rewind" });
  });
});

describe("rewindPreview", () => {
  it("folds whitespace and cuts long text with an ellipsis", () => {
    expect(rewindPreview("  fix\nthe   build ")).toBe("fix the build");
    expect(rewindPreview("abcdefghij", 5)).toBe("abcd…");
  });
});
