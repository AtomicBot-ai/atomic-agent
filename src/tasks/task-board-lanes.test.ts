import { describe, expect, it } from "vitest";

import {
  BOARD_LANES,
  BoardValidationError,
  buildBoardCards,
  groupCardsByLane,
  laneForCard,
  laneForStatus,
  validateBoardPatch,
  type BoardEntry,
} from "./task-board-lanes.js";
import type { TaskRecord, TaskStatus } from "./task-types.js";

function task(id: string, status: TaskStatus, startedAt: number | null = null): TaskRecord {
  return { id, status, startedAt } as unknown as TaskRecord;
}

function entry(taskId: string, patch: Partial<BoardEntry>): BoardEntry {
  return {
    taskId,
    lane: null,
    laneSetAt: null,
    note: null,
    assignee: null,
    updatedAt: 0,
    ...patch,
  };
}

describe("task board lanes (ATO-2257)", () => {
  it("derives a lane from every task status", () => {
    expect(laneForStatus("pending")).toBe("todo");
    expect(laneForStatus("paused")).toBe("todo");
    expect(laneForStatus("running")).toBe("doing");
    expect(laneForStatus("failed")).toBe("blocked");
    expect(laneForStatus("blocked")).toBe("blocked");
    expect(laneForStatus("completed")).toBe("done");
    expect(laneForStatus("cancelled")).toBe("done");
  });

  it("keeps a lane someone set until the task starts a new run", () => {
    const moved = entry("t1", { lane: "review", laneSetAt: 2_000 });
    // Moved during the run that started at 1000: stays in review after it completes.
    expect(laneForCard(task("t1", "completed", 1_000), moved)).toEqual({
      lane: "review",
      laneSource: "board",
    });
    // Never ran: the set lane holds.
    expect(laneForCard(task("t1", "pending", null), moved).lane).toBe("review");
    // A run started after the move: the card follows the status again.
    expect(laneForCard(task("t1", "running", 3_000), moved)).toEqual({
      lane: "doing",
      laneSource: "status",
    });
  });

  it("falls back to the status when only a note or assignee is stored", () => {
    const noteOnly = entry("t1", { note: "check the logs", updatedAt: 5_000 });
    expect(laneForCard(task("t1", "failed", 1_000), noteOnly)).toEqual({
      lane: "blocked",
      laneSource: "status",
    });
  });

  it("checks and normalises a patch", () => {
    expect(validateBoardPatch({ lane: "review", note: "  looks done  ", assignee: "coder" })).toEqual({
      lane: "review",
      note: "looks done",
      assignee: "coder",
    });
    expect(validateBoardPatch({ note: "   ", assignee: "" })).toEqual({ note: null, assignee: null });
    expect(validateBoardPatch({ lane: null })).toEqual({ lane: null });
    expect(validateBoardPatch({})).toEqual({});
  });

  it("refuses a bad lane, note or assignee with the field named", () => {
    const fieldOf = (raw: Parameters<typeof validateBoardPatch>[0]) => {
      try {
        validateBoardPatch(raw);
        return null;
      } catch (err) {
        return err instanceof BoardValidationError ? err.field : "other";
      }
    };
    expect(fieldOf({ lane: "archived" })).toBe("lane");
    expect(fieldOf({ lane: 3 })).toBe("lane");
    expect(fieldOf({ note: 42 })).toBe("note");
    expect(fieldOf({ note: "x".repeat(2_001) })).toBe("note");
    expect(fieldOf({ assignee: "Coder Bot" })).toBe("assignee");
    expect(fieldOf({ assignee: "../etc" })).toBe("assignee");
  });

  it("builds cards in task order and groups them into every lane", () => {
    const tasks = [task("a", "pending"), task("b", "running", 10), task("c", "completed", 10)];
    const entries = new Map([
      ["c", entry("c", { lane: "review", laneSetAt: 20, note: "please look", assignee: "reviewer", updatedAt: 20 })],
    ]);
    const cards = buildBoardCards(tasks, entries);
    expect(cards.map((c) => [c.task.id, c.lane, c.laneSource])).toEqual([
      ["a", "todo", "status"],
      ["b", "doing", "status"],
      ["c", "review", "board"],
    ]);
    expect(cards[2]).toMatchObject({ note: "please look", assignee: "reviewer", boardUpdatedAt: 20 });
    const lanes = groupCardsByLane(cards);
    expect(Object.keys(lanes)).toEqual([...BOARD_LANES]);
    expect(lanes.review.map((c) => c.task.id)).toEqual(["c"]);
    expect(lanes.blocked).toEqual([]);
  });
});
