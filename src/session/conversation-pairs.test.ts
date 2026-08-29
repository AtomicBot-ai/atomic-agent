import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  assistantToolCallTurn,
  macroTurnBoundaries,
  packConversation,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

const BASE = Date.parse("2026-08-27T10:00:00Z");
let clock = 0;
const at = (): number => BASE + (clock += 1000);

/** One complete task: ask, one tool round-trip, answer. */
function task(label: string): ConversationTurn[] {
  return [
    userTurn(`ask ${label}`, at()),
    assistantToolCallTurn({ tool: "fs.read", args: { path: `/${label}` }, at: at() }),
    toolResultTurn({ tool: "fs.read", status: "ok", summary: `read ${label}`, at: at() }),
    assistantReplyTurn(`answer ${label}`, at()),
  ];
}

/** A task the operator cut short: no reply row is ever written. */
function abandonedTask(label: string): ConversationTurn[] {
  return [
    userTurn(`ask ${label}`, at()),
    assistantToolCallTurn({ tool: "fs.read", args: { path: `/${label}` }, at: at() }),
    toolResultTurn({ tool: "fs.read", status: "ok", summary: `read ${label}`, at: at() }),
  ];
}

/** Generous enough that only the pairs cap can bite. */
const NO_TOKEN_PRESSURE = 1_000_000;

describe("counting macro-turns", () => {
  it("opens a pair at each task", () => {
    const turns = [...task("a"), ...task("b"), ...task("c")];
    expect(macroTurnBoundaries(turns)).toEqual([0, 4, 8]);
  });

  it("does not open a pair for a steering message", () => {
    // Typing while the agent runs appends another `user` row inside the
    // same task. Keying on `user` alone would read that as a new task
    // and the operator's count would climb without them asking anything.
    const turns: ConversationTurn[] = [
      userTurn("ask a", at()),
      assistantToolCallTurn({ tool: "fs.read", args: {}, at: at() }),
      userTurn("actually, also check b", at()),
      toolResultTurn({ tool: "fs.read", status: "ok", summary: "ok", at: at() }),
      assistantReplyTurn("answer a", at()),
      ...task("c"),
    ];
    expect(macroTurnBoundaries(turns)).toEqual([0, 5]);
  });

  it("trusts recorded boundaries over the shape of the transcript", () => {
    // A cancelled or `finish`-ended task writes no reply, so derivation
    // fuses it into whatever came next. The session records the real
    // boundary at the moment the task ends.
    const turns = [...abandonedTask("a"), ...task("b")];
    expect(macroTurnBoundaries(turns), "derived misses it").toEqual([0]);
    expect(macroTurnBoundaries(turns, [3])).toEqual([0, 3]);
  });

  it("ignores recorded boundaries that no longer address a turn", () => {
    const turns = task("a");
    expect(macroTurnBoundaries(turns, [0, 4, 99, -2])).toEqual([0]);
  });
});

describe("packing by pairs", () => {
  it("keeps exactly the last N tasks", () => {
    const turns = [...task("a"), ...task("b"), ...task("c"), ...task("d")];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 2 });
    expect(out.visiblePairs).toBe(2);
    expect(out.droppedPairs).toBe(2);
    expect(out.visibleTurns).toHaveLength(8);
    expect(out.visibleTurns[0]).toEqual(turns[8]);
  });

  it("cuts on a task boundary, never mid-task", () => {
    // A cut landing after the last reply would make every surviving row
    // render as "fresh", which uncaps `os.http.request` bodies and
    // silently inflates the section.
    const turns = [...task("a"), ...task("b"), ...task("c")];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(out.visibleTurns[0]?.kind).toBe("user");
    expect(macroTurnBoundaries(turns)).toContain(
      turns.length - out.visibleTurns.length,
    );
  });

  it("holds history down even when it would have fitted on tokens", () => {
    // The knob exists to bound history on purpose, not only to rescue a
    // prompt that overflowed.
    const turns = [...task("a"), ...task("b"), ...task("c")];
    const uncapped = packConversation(turns, NO_TOKEN_PRESSURE);
    expect(uncapped.droppedCount).toBe(0);
    const capped = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(capped.droppedCount).toBeGreaterThan(0);
  });

  it("leaves everything alone when there are fewer tasks than the cap", () => {
    const turns = [...task("a"), ...task("b")];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 10 });
    expect(out.droppedCount).toBe(0);
    expect(out.visiblePairs).toBe(2);
    expect(out.visibleTurns).toEqual(turns);
  });

  it("names the tasks it dropped, not just the rows", () => {
    const turns = [...task("a"), ...task("b"), ...task("c")];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(out.droppedSummary).toContain("from 2 earlier tasks");
  });

  it("says task, singular, when it dropped one", () => {
    const turns = [...task("a"), ...task("b")];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(out.droppedSummary).toContain("from 1 earlier task ");
  });
});

describe("tokens remain the ceiling", () => {
  it("trims completed tasks under token pressure even with pairs to spare", () => {
    // A pair has no bounded size — one task can run `maxSteps` tool
    // calls — so no pairs value keeps a prompt inside the window on its
    // own. With the pairs cap slack, tokens must still cut.
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 12; i += 1) {
      turns.push(
        userTurn(`ask ${i}`, at()),
        toolResultTurn({
          tool: "fs.read",
          status: "ok",
          summary: "x".repeat(400),
          at: at(),
        }),
        assistantReplyTurn(`answer ${i}`, at()),
      );
    }
    const out = packConversation(turns, 400, { maxPairs: 100 });
    expect(out.droppedCount).toBeGreaterThan(0);
    expect(out.visibleTurns.length).toBeLessThan(turns.length);
  });

  it("cannot trim the task still in flight, by design", () => {
    // Documenting a real limit rather than asserting it away. The last
    // `user` turn is pinned unconditionally, so a single runaway task
    // survives whatever either limit says — the pin exists so the model
    // never loses the request it is answering, and the cost is that one
    // task with a huge tool result can still overflow the window.
    const turns: ConversationTurn[] = [userTurn("ask big", at())];
    for (let i = 0; i < 40; i += 1) {
      turns.push(
        assistantToolCallTurn({ tool: "fs.read", args: { path: `/f${i}` }, at: at() }),
        toolResultTurn({
          tool: "fs.read",
          status: "ok",
          summary: "x".repeat(400),
          at: at(),
        }),
      );
    }
    const out = packConversation(turns, 400, { maxPairs: 1 });
    expect(out.droppedCount).toBe(0);
  });

  it("takes whichever limit cuts more", () => {
    const turns = [...task("a"), ...task("b"), ...task("c"), ...task("d")];
    // Pairs allows three tasks; tokens allow far less. The tighter wins.
    const out = packConversation(turns, 60, { maxPairs: 3 });
    expect(out.visiblePairs).toBeLessThanOrEqual(3);
    expect(out.droppedCount).toBeGreaterThan(turns.length - 12);
  });
});

describe("the pins survive a pairs cut", () => {
  it("always keeps the newest user turn", () => {
    const turns = [...task("a"), ...task("b"), userTurn("ask now", at())];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(out.visibleTurns.at(-1)).toEqual(turns.at(-1));
  });

  it("keeps the opening instruction of the task in flight", () => {
    // A drained steer must not become the only surviving instruction.
    const turns: ConversationTurn[] = [
      ...task("a"),
      userTurn("ask b", at()),
      assistantToolCallTurn({ tool: "fs.read", args: {}, at: at() }),
      userTurn("no, do it this way", at()),
    ];
    const out = packConversation(turns, NO_TOKEN_PRESSURE, { maxPairs: 1 });
    expect(out.visibleTurns[0]).toEqual(turns[4]);
  });
});
