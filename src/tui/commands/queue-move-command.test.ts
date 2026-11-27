import { describe, expect, it, vi } from "vitest";

import { parseQueueMoveCommand, queueMoveLine } from "./queue-move-command.js";

describe("parseQueueMoveCommand (ATO-2476)", () => {
  it("reads `next <n>` and `move <n> <place>`, counted from 1", () => {
    expect(parseQueueMoveCommand("next 3")).toEqual({ from: 2, to: 0 });
    expect(parseQueueMoveCommand("  NEXT 2 ")).toEqual({ from: 1, to: 0 });
    expect(parseQueueMoveCommand("move 1 3")).toEqual({ from: 0, to: 2 });
    expect(parseQueueMoveCommand("move 4 to 1")).toEqual({ from: 3, to: 0 });
  });

  it("leaves anything else to be parked as a message", () => {
    expect(parseQueueMoveCommand("next steps for the doc")).toBeNull();
    expect(parseQueueMoveCommand("move the tests first")).toBeNull();
    expect(parseQueueMoveCommand("next")).toBeNull();
    expect(parseQueueMoveCommand("")).toBeNull();
  });
});

describe("queueMoveLine (ATO-2476)", () => {
  const queued = ["a", "b", "c"];

  it("applies a valid move and says where the message went", () => {
    const apply = vi.fn(() => true);
    expect(queueMoveLine({ from: 2, to: 0 }, queued, apply)).toBe("queue: message 3 goes next");
    expect(apply).toHaveBeenCalledWith(2, 0);
    expect(queueMoveLine({ from: 0, to: 2 }, queued, apply)).toBe("queue: message 1 moved to place 3");
  });

  it("explains a number out of range or a move to the same place without asking the orchestrator", () => {
    const apply = vi.fn(() => true);
    expect(queueMoveLine({ from: 5, to: 0 }, queued, apply)).toMatch(/no message 6; pick a number from 1 to 3/);
    expect(queueMoveLine({ from: 0, to: 7 }, queued, apply)).toMatch(/no place 8/);
    expect(queueMoveLine({ from: 0, to: 0 }, queued, apply)).toBe("queue: message 1 already goes next");
    expect(queueMoveLine({ from: 1, to: 0 }, [], apply)).toMatch(/nothing is parked/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("says so when the orchestrator's queue disagrees", () => {
    expect(queueMoveLine({ from: 1, to: 0 }, queued, () => false)).toMatch(/nothing was moved/);
    expect(queueMoveLine({ from: 1, to: 0 }, queued, undefined)).toMatch(/nothing was moved/);
  });

  it("uses no long dash", () => {
    for (const line of [
      queueMoveLine({ from: 2, to: 0 }, queued, () => true),
      queueMoveLine({ from: 9, to: 0 }, queued, () => true),
      queueMoveLine({ from: 1, to: 0 }, queued, () => false),
    ]) expect(line).not.toMatch(/—/);
  });
});
