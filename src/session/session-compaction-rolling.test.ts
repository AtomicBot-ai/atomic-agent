import { describe, expect, it } from "vitest";
import { createEmptySessionState, recordTurn, type SessionState } from "./session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "./conversation-turn.js";
import { normalizeSessionState } from "./normalize-session-state.js";
import { compactionBoundaryHash, summaryTextHash, validRollingSummary, type RollingCompactionSummary } from "./session-compaction.js";

function history(steps = 4): SessionState {
  let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: "/tmp" }), userTurn("keep the green button"));
  for (let i = 0; i < steps; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}` }));
  }
  return state;
}
function rolling(state: SessionState, through: number, extra: Partial<RollingCompactionSummary> = {}): RollingCompactionSummary {
  return { version: 1, summary: "Goal: keep the green button.", from: 0, baseHash: summaryTextHash(""), coveredThrough: through,
    boundaryHash: compactionBoundaryHash(state.turns[through - 1]!), createdAt: 1, model: "m", ...extra };
}
const roundTrip = (state: SessionState) => normalizeSessionState(JSON.parse(JSON.stringify(state)));

describe("rolling compaction summary state", () => {
  it("leaves a session saved before the field unchanged", () => {
    const old = history();
    const loaded = roundTrip(old);
    expect(loaded).not.toHaveProperty("rollingSummary");
    expect(loaded.turns).toEqual(old.turns);
    expect(validRollingSummary(loaded)).toBeNull();
  });

  it("persists a valid summary through a save and load", () => {
    const state = history();
    state.rollingSummary = rolling(state, 5);
    expect(roundTrip(state).rollingSummary).toEqual(state.rollingSummary);
    expect(validRollingSummary(roundTrip(state))).toMatchObject({ coveredThrough: 5 });
  });

  it("drops a stale summary: edited boundary, truncated history, unsafe cut, other checkpoint", () => {
    const state = history();
    const edited = { ...state, turns: [...state.turns] };
    edited.turns[4] = toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "changed" });
    edited.rollingSummary = rolling(state, 5);
    expect(roundTrip(edited)).not.toHaveProperty("rollingSummary");
    const truncated = { ...state, turns: state.turns.slice(0, 3), rollingSummary: rolling(state, 5) };
    expect(validRollingSummary(truncated)).toBeNull();
    // Between a call and its result.
    expect(validRollingSummary({ ...state, rollingSummary: rolling(state, 4) })).toBeNull();
    const other = { ...state, rollingSummary: rolling(state, 5, { baseHash: summaryTextHash("another checkpoint") }) };
    expect(validRollingSummary(other)).toBeNull();
    expect(validRollingSummary({ ...state, rollingSummary: rolling(state, 5, { from: 1 }) })).toBeNull();
  });

  it("must extend the current checkpoint", () => {
    const state = history();
    state.compaction = { version: 1, summary: "checkpoint", coveredThrough: 3, boundaryHash: compactionBoundaryHash(state.turns[2]!),
      createdAt: 1, reason: "manual", model: null, tokensBefore: 10, tokensAfter: 5 };
    expect(validRollingSummary({ ...state, rollingSummary: rolling(state, 5) })).toBeNull();
    const extending = rolling(state, 7, { from: 3, baseHash: summaryTextHash("checkpoint") });
    expect(validRollingSummary({ ...state, rollingSummary: extending })).toEqual(extending);
    expect(validRollingSummary({ ...state, rollingSummary: { ...extending, coveredThrough: 3,
      boundaryHash: compactionBoundaryHash(state.turns[2]!) } })).toBeNull();
  });
});
