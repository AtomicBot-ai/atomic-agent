import { describe, expect, it } from "vitest";
import {
  macroTurnBoundaries,
  packConversation,
  type ConversationTurn,
} from "./conversation-turn.js";
import {
  MACRO_TURN_START_CAP,
  appendMacroTurnStart,
  macroTurnStartsFromTurns,
} from "./macro-turn-starts.js";

const user = (text: string, at: number): ConversationTurn => ({
  kind: "user",
  text,
  at,
});
const reply = (text: string, at: number): ConversationTurn => ({
  kind: "assistant_reply",
  text,
  at,
});
const call = (at: number): ConversationTurn => ({
  kind: "assistant_tool_call",
  tool: "shell",
  args: {},
  at,
});
const result = (at: number): ConversationTurn => ({
  kind: "tool_result",
  tool: "shell",
  status: "ok",
  summary: "ok",
  at,
});

describe("appendMacroTurnStart", () => {
  it("appends and skips a repeated index", () => {
    expect(appendMacroTurnStart(undefined, 3)).toEqual([3]);
    expect(appendMacroTurnStart([3], 3)).toEqual([3]);
    expect(appendMacroTurnStart([3], 7)).toEqual([3, 7]);
  });

  it("keeps only the newest entries past the cap", () => {
    let starts: number[] = [];
    for (let i = 1; i <= MACRO_TURN_START_CAP + 5; i += 1) {
      starts = appendMacroTurnStart(starts, i);
    }
    expect(starts).toHaveLength(MACRO_TURN_START_CAP);
    expect(starts[0]).toBe(6);
    expect(starts[starts.length - 1]).toBe(MACRO_TURN_START_CAP + 5);
  });
});

describe("macroTurnStartsFromTurns", () => {
  it("opens a macro-turn at every user row after the first", () => {
    const turns = [
      user("a", 1),
      reply("b", 2),
      user("c", 3),
      call(4),
      result(5),
      user("d", 6),
      reply("e", 7),
    ];
    expect(macroTurnStartsFromTurns(turns)).toEqual([2, 5]);
  });

  it("returns nothing for an empty or single-task transcript", () => {
    expect(macroTurnStartsFromTurns([])).toEqual([]);
    expect(macroTurnStartsFromTurns([user("a", 1), reply("b", 2)])).toEqual([]);
  });

  it("applies the runtime cap", () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < MACRO_TURN_START_CAP + 10; i += 1) {
      turns.push(user(`u${i}`, i));
    }
    const starts = macroTurnStartsFromTurns(turns);
    expect(starts).toHaveLength(MACRO_TURN_START_CAP);
    expect(starts[starts.length - 1]).toBe(MACRO_TURN_START_CAP + 9);
  });

  it("segments a reply-before-tool-call transcript where derivation cannot", () => {
    // Claude Code emits the reply text before the tool calls of the same
    // message, so the second task's user row follows a tool_result, not
    // an assistant_reply — the derived scan fuses both tasks into one.
    const turns = [
      user("list files", 1),
      reply("running it", 2),
      call(3),
      result(4),
      user("now delete them", 5),
      reply("done", 6),
    ];
    expect(macroTurnBoundaries(turns)).toEqual([0]);
    const starts = macroTurnStartsFromTurns(turns);
    expect(macroTurnBoundaries(turns, starts)).toEqual([0, 4]);

    const packed = packConversation(turns, 10_000, {
      maxPairs: 1,
      macroTurnStarts: starts,
    });
    expect(packed.visiblePairs).toBe(1);
    expect(packed.droppedPairs).toBe(1);
    expect(packed.visibleTurns).toEqual(turns.slice(4));
  });
});
