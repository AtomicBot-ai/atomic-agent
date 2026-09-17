import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONVERSATION_LOW_WATER,
  assistantReplyTurn,
  assistantToolCallTurn,
  packConversation,
  renderTurnForPrompt,
  toolResultTurn,
  userTurn,
  type ConversationPackStart,
  type ConversationTurn,
} from "./conversation-turn.js";
import { estimateTokens } from "../prompt/token-budget.js";
import {
  createEmptySessionState,
  rememberConversationPackStart,
} from "./session-state.js";

/**
 * A cut that moved on every step was the single largest cost in the
 * fusion benchmark: with Gemma 4's sliding-window attention every change
 * ahead of the conversation — the `summary: N older turns dropped` line
 * included — re-read the whole 44K-token prompt, 40 of one turn's 79
 * minutes. The packer now cuts in chunks and holds the cut, so between
 * cuts the prompt is append-only.
 */

const BASE = Date.parse("2026-09-14T10:00:00Z");
let clock = 0;
const at = (): number => BASE + (clock += 1000);

/** One tool round-trip of a fixed size, roughly `size` tokens. */
function step(label: string, size = 60): ConversationTurn[] {
  return [
    assistantToolCallTurn({
      tool: "fs.read",
      args: { path: `/${label}` },
      at: at(),
    }),
    toolResultTurn({
      tool: "fs.read",
      status: "ok",
      summary: `${label} ${"x".repeat(size * 4)}`,
      at: at(),
    }),
  ];
}

/** One complete task: ask, `steps` tool round-trips, answer. */
function task(label: string, steps = 1): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn(`ask ${label}`, at())];
  for (let i = 0; i < steps; i += 1) turns.push(...step(`${label}-${i}`));
  turns.push(assistantReplyTurn(`answer ${label}`, at()));
  return turns;
}

/** A task still running: ask plus `steps` round-trips, no answer yet. */
function openTask(label: string, steps: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn(`ask ${label}`, at())];
  for (let i = 0; i < steps; i += 1) turns.push(...step(`${label}-${i}`));
  return turns;
}

/** The packer's own cost of a visible tail (every row rendered fresh). */
function tokensOf(turns: readonly ConversationTurn[]): number {
  return turns.reduce(
    (sum, turn) =>
      sum +
      estimateTokens(renderTurnForPrompt(turn, { inCurrentMacroTurn: true })) +
      1,
    0,
  );
}

const NO_PAIRS_PRESSURE = 1_000;

describe("packConversation holds its cut between overflows", () => {
  it("drops to the low-water mark instead of just enough", () => {
    // A long finished task and a short running one: the cut lands inside
    // the finished task, where no pin interferes.
    const turns = [...task("a", 12), ...openTask("b", 2)];
    const budget = 800;
    const cutJustEnough = packConversation(turns, budget, { lowWater: 1 });
    const chunked = packConversation(turns, budget);
    expect(cutJustEnough.droppedCount).toBeGreaterThan(0);
    // More is dropped than the budget alone requires…
    expect(chunked.droppedCount).toBeGreaterThan(cutJustEnough.droppedCount);
    // …down to about 65 % of it.
    expect(tokensOf(chunked.visibleTurns)).toBeLessThan(budget * 0.7);
    expect(tokensOf(cutJustEnough.visibleTurns)).toBeGreaterThan(budget * 0.8);
    expect(chunked.boundBy).toBe("tokens");
    const index = chunked.droppedCount;
    expect(chunked.packStart).toEqual({
      index,
      at: turns[index]!.at,
      boundBy: "tokens",
    });
  });

  it("keeps the same start — and the identical summary line — while the tail fits", () => {
    const budget = 800;
    const turns = [...task("a", 6), ...task("b", 6), ...openTask("c", 1)];
    const first = packConversation(turns, budget);
    expect(first.droppedCount).toBeGreaterThan(0);
    const start = first.packStart!;
    expect(start.index).toBeGreaterThan(0);

    // The next steps append; nothing ahead of the appended rows moves.
    const grown = [...turns, ...step("c-1"), ...step("c-2")];
    const held = packConversation(grown, budget, { packStart: start });
    expect(held.packStart).toEqual(start);
    expect(held.droppedSummary).toBe(first.droppedSummary);
    expect(held.visibleTurns.slice(0, first.visibleTurns.length)).toEqual(
      first.visibleTurns,
    );
    expect(held.visibleTurns).toHaveLength(first.visibleTurns.length + 4);
    expect(held.boundBy).toBe("tokens");

    // Without the memory the very same transcript would be cut again.
    const forgotten = packConversation(grown, budget);
    expect(forgotten.droppedCount).toBeGreaterThan(held.droppedCount);
  });

  it("cuts again, further on, once the held tail overflows the budget", () => {
    const budget = 800;
    const turns = [...task("a", 6), ...task("b", 6), ...openTask("c", 1)];
    const first = packConversation(turns, budget);
    const start = first.packStart!;
    // The running task finishes and two more long ones follow.
    const grown = [
      ...turns,
      assistantReplyTurn("answer c", at()),
      ...task("d", 6),
      ...task("e", 6),
      ...openTask("f", 1),
    ];
    const recut = packConversation(grown, budget, { packStart: start });
    expect(recut.packStart!.index).toBeGreaterThan(start.index);
    expect(recut.droppedSummary).not.toBe(first.droppedSummary);
    // The new tail sits at the low-water mark, not at the budget…
    expect(tokensOf(recut.visibleTurns)).toBeLessThan(budget * 0.7);
    // …and holds from there.
    const again = packConversation([...grown, ...step("f-1")], budget, {
      packStart: recut.packStart,
    });
    expect(again.packStart).toEqual(recut.packStart);
    expect(again.droppedSummary).toBe(recut.droppedSummary);
  });

  it("ignores a remembered start that no longer addresses this transcript", () => {
    const budget = 800;
    const turns = [...task("a", 6), ...task("b", 6), ...openTask("c", 1)];
    const fresh = packConversation(turns, budget);
    const stale: ConversationPackStart = {
      index: 3,
      at: turns[3]!.at + 1, // a different turn once sat here
      boundBy: "tokens",
    };
    expect(packConversation(turns, budget, { packStart: stale })).toEqual(
      fresh,
    );
    const outOfRange: ConversationPackStart = {
      index: turns.length + 5,
      at: 0,
      boundBy: "tokens",
    };
    expect(
      packConversation(turns, budget, { packStart: outOfRange }),
    ).toEqual(fresh);
  });

  it("applies the same hysteresis to the pairs cap", () => {
    const tasks = ["a", "b", "c", "d", "e"].map((l) => task(l));
    const turns = tasks.flat();
    const first = packConversation(turns, NO_PAIRS_PRESSURE * 1000, {
      maxPairs: 4,
    });
    // Five tasks against a cap of four: down to floor(4 × 0.65) = 2.
    expect(first.visiblePairs).toBe(2);
    expect(first.boundBy).toBe("pairs");
    const start = first.packStart!;

    // Two more tasks (four visible) fit the cap: the start holds.
    const grown = [...turns, ...task("f"), ...task("g")];
    const held = packConversation(grown, NO_PAIRS_PRESSURE * 1000, {
      maxPairs: 4,
      packStart: start,
    });
    expect(held.packStart).toEqual(start);
    expect(held.visiblePairs).toBe(4);
    expect(held.droppedSummary).toBe(first.droppedSummary);

    // A fifth visible task overflows the cap: cut again to two.
    const recut = packConversation(
      [...grown, ...task("h")],
      NO_PAIRS_PRESSURE * 1000,
      { maxPairs: 4, packStart: start },
    );
    expect(recut.visiblePairs).toBe(2);
    expect(recut.packStart!.index).toBeGreaterThan(start.index);
  });

  it("never keeps fewer than one task on a pairs cut", () => {
    const turns = [...task("a"), ...task("b"), ...task("c")];
    const out = packConversation(turns, NO_PAIRS_PRESSURE * 1000, {
      maxPairs: 1,
    });
    expect(out.visiblePairs).toBe(1);
    expect(out.visibleTurns[0]?.kind).toBe("user");
  });

  it("still pins the last user turn and the running task's opening turn", () => {
    const turns = [...task("a"), ...openTask("b", 6), userTurn("steer", at())];
    const out = packConversation(turns, 300);
    expect(out.visibleTurns.at(-1)?.kind).toBe("user");
    expect(out.visibleTurns[0]).toEqual(turns[4]);
    // A held start is subject to the same pins on the next build.
    const held = packConversation(turns, 300, { packStart: out.packStart });
    expect(held.visibleTurns[0]).toEqual(turns[4]);
    expect(held.packStart).toEqual(out.packStart);
  });

  it("treats an unusable low-water share as the default", () => {
    const turns = [...task("a", 12), ...openTask("b", 2)];
    const budget = 800;
    const byDefault = packConversation(turns, budget);
    for (const lowWater of [0, -1, 2, Number.NaN]) {
      expect(packConversation(turns, budget, { lowWater })).toEqual(byDefault);
    }
    expect(
      packConversation(turns, budget, {
        lowWater: DEFAULT_CONVERSATION_LOW_WATER,
      }),
    ).toEqual(byDefault);
  });
});

describe("rememberConversationPackStart", () => {
  it("records a cut, keeps the object when nothing changed, and forgets on null", () => {
    const state = createEmptySessionState({ id: "s", workingDir: "/w" });
    const start: ConversationPackStart = { index: 4, at: 1, boundBy: "tokens" };
    const remembered = rememberConversationPackStart(state, start);
    expect(remembered.conversationPackStart).toEqual(start);
    expect(rememberConversationPackStart(remembered, { ...start })).toBe(
      remembered,
    );
    expect(rememberConversationPackStart(state, null)).toBe(state);
    const forgotten = rememberConversationPackStart(remembered, null);
    expect(forgotten).not.toHaveProperty("conversationPackStart");
  });
});
