import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCardEntry } from "../tui-state.js";
import {
  formatTurnFoldDuration,
  lastTurnFoldId,
  turnFoldLabel,
  turnFoldLineText,
  turnFoldsOf,
} from "./turn-collapse.js";

function card(
  id: string,
  status: ToolCardEntry["status"] = "ok",
  tool = "os.fs.read",
): ToolCardEntry {
  return {
    id,
    stepIndex: 0,
    tool,
    args: {},
    status,
    summary: "done",
    truncated: false,
    startedAt: 0,
    finishedAt: status === "pending" ? null : 1,
  };
}

function user(id: string, timestamp: number, steered = false): ChatMessage {
  return {
    id,
    role: "user",
    text: "do it",
    timestamp,
    ...(steered ? { steered: true } : {}),
  };
}

function assistant(
  id: string,
  timestamp: number,
  cards: ToolCardEntry[] = [],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "Done!",
    timestamp,
    ...(cards.length > 0 ? { toolCards: cards } : {}),
    ...extra,
  };
}

function system(id: string, timestamp: number): ChatMessage {
  return { id, role: "system", text: "note", timestamp };
}

describe("turnFoldsOf", () => {
  it("folds a finished turn with tool cards into one entry", () => {
    const log = [
      user("u1", 1_000),
      assistant("a1", 41_000, [card("c1"), card("c2"), card("c3", "error")], {
        reasoningBlocks: ["think", "think more"],
      }),
    ];
    const folds = turnFoldsOf(log);
    expect([...folds.keys()]).toEqual(["a1"]);
    const f = folds.get("a1")!;
    expect(f.tools).toBe(3);
    expect(f.failed).toBe(1);
    expect(f.unfinished).toBe(0);
    expect(f.reasons).toBe(2);
    expect(f.durationMs).toBe(40_000);
  });

  it("leaves a reply with no visible tool card alone", () => {
    const log = [
      user("u1", 1),
      assistant("a1", 2, [], { reasoningBlocks: ["think"] }),
      user("u2", 3),
      // `reply` is never drawn, so it is not a step either.
      assistant("a2", 4, [card("r", "ok", "reply")]),
    ];
    expect(turnFoldsOf(log).size).toBe(0);
  });

  it("never folds user or system messages", () => {
    const log = [user("u1", 1), system("s1", 2)];
    expect(turnFoldsOf(log).size).toBe(0);
  });

  it("folds nothing when always-show-steps is on", () => {
    const log = [user("u1", 1), assistant("a1", 2, [card("c1")])];
    expect(turnFoldsOf(log, { always: true }).size).toBe(0);
  });

  it("does not fold the running turn, only the finished ones before it", () => {
    const log = [
      user("u1", 1),
      assistant("a1", 2, [card("c1")]),
      user("u2", 3),
      // An interim progress note of the turn still running.
      assistant("a2", 4, [card("c2")], { progressNote: true }),
    ];
    const folds = turnFoldsOf(log, { running: true });
    expect([...folds.keys()]).toEqual(["a1"]);
    // Once the turn ends, its note folds like any other reply.
    expect([...turnFoldsOf(log).keys()]).toEqual(["a1", "a2"]);
  });

  it("a steer does not start a new turn while running", () => {
    const log = [
      user("u1", 1),
      assistant("a1", 2, [card("c1")], { progressNote: true }),
      user("s", 3, true),
    ];
    expect(turnFoldsOf(log, { running: true }).size).toBe(0);
  });

  it("times a progress-note segment from the previous reply", () => {
    const log = [
      user("u1", 1_000),
      assistant("a1", 6_000, [card("c1")], { progressNote: true }),
      system("s1", 7_000),
      user("steer", 8_000, true),
      assistant("a2", 16_000, [card("c2")]),
    ];
    const folds = turnFoldsOf(log);
    expect(folds.get("a1")!.durationMs).toBe(5_000);
    expect(folds.get("a2")!.durationMs).toBe(10_000);
  });

  it("prints no time when the turn's start is not on screen", () => {
    const log = [assistant("a1", 5_000, [card("c1")])];
    expect(turnFoldsOf(log).get("a1")!.durationMs).toBeNull();
  });

  it("counts unfinished cards of a stopped turn apart from failures", () => {
    const log = [
      user("u1", 1),
      assistant("a1", 2, [card("c1", "pending"), card("c2", "error")]),
    ];
    const f = turnFoldsOf(log).get("a1")!;
    expect(f.failed).toBe(1);
    expect(f.unfinished).toBe(1);
  });
});

describe("turnFoldLineText", () => {
  const log = [
    user("u1", 0),
    assistant("a1", 40_000, [1, 2, 3, 4, 5, 6].map((n) => card(`c${n}`))),
  ];
  const fold = turnFoldsOf(log).get("a1")!;

  it("reads like the desktop line", () => {
    expect(turnFoldLineText(fold, { open: false })).toBe(
      "Used 6 tools · 40s ▸",
    );
    expect(turnFoldLineText(fold, { open: true })).toBe("Used 6 tools · 40s ▾");
  });

  it("names failures and unfinished calls before the time", () => {
    const f = turnFoldsOf([
      user("u1", 0),
      assistant("a1", 3_000, [
        card("c1"),
        card("c2", "error"),
        card("c3", "pending"),
      ]),
    ]).get("a1")!;
    expect(turnFoldLineText(f, { open: false })).toBe(
      "Used 3 tools · 1 failed · 1 unfinished · 3s ▸",
    );
  });

  it("uses the singular for one tool and drops an unknown time", () => {
    const f = turnFoldsOf([assistant("a1", 1, [card("c1")])]).get("a1")!;
    expect(turnFoldLineText(f, { open: false })).toBe("Used 1 tool ▸");
  });

  it("takes the words from a describer when one is given", () => {
    expect(turnFoldLabel(fold, () => "Read 6 files")).toBe("Read 6 files");
    expect(turnFoldLabel(fold, () => null)).toBe("Used 6 tools");
    expect(turnFoldLabel(fold, () => "  ")).toBe("Used 6 tools");
  });
});

describe("formatTurnFoldDuration", () => {
  it("formats seconds and minutes, never a made-up zero", () => {
    expect(formatTurnFoldDuration(null)).toBeNull();
    expect(formatTurnFoldDuration(0)).toBeNull();
    expect(formatTurnFoldDuration(-5)).toBeNull();
    expect(formatTurnFoldDuration(400)).toBe("<1s");
    expect(formatTurnFoldDuration(40_000)).toBe("40s");
    expect(formatTurnFoldDuration(67_000)).toBe("1m 07s");
  });
});

describe("lastTurnFoldId", () => {
  it("finds the newest folded turn", () => {
    const log = [
      user("u1", 1),
      assistant("a1", 2, [card("c1")]),
      user("u2", 3),
      assistant("a2", 4),
    ];
    expect(lastTurnFoldId(log)).toBe("a1");
    expect(lastTurnFoldId([user("u1", 1)])).toBeNull();
  });
});
