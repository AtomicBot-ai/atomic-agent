import { describe, expect, it } from "vitest";
import {
  criticalPath,
  fanoutPathReport,
  renderPathLine,
  workMs,
} from "./critical-path.js";

const min = 60_000;

describe("criticalPath", () => {
  // a → c → d and b → d: a 3m, b 5m, c 6m (1m of it queued), d 4m.
  const tasks = [
    { id: "a", durationMs: 3 * min },
    { id: "b", durationMs: 5 * min },
    { id: "c", durationMs: 6 * min, queueWaitMs: 1 * min },
    { id: "d", durationMs: 4 * min },
  ];
  const deps = new Map([
    ["c", ["a"]],
    ["d", ["c", "b"]],
  ]);

  it("finds the longest chain on a four-task tree, by working time", () => {
    expect(workMs(tasks[2]!)).toBe(5 * min);
    expect(criticalPath(tasks, deps)).toEqual({
      path: ["a", "c", "d"],
      ms: 12 * min,
    });
  });

  it("states total work and idle local slot time", () => {
    const report = fanoutPathReport({
      tasks,
      dependencies: deps,
      wallMs: 13 * min,
      localSlots: 2,
      isLocal: () => true,
    });
    expect(report.totalWorkMs).toBe(17 * min);
    // 2 slots × 13m = 26m of slot time, 17m worked.
    expect(report.idleLocalSlotMs).toBe(9 * min);
    expect(renderPathLine(report)).toBe(
      "\n\nCritical path 12m (tasks a → c → d), total work 17m, idle local slot 9m.",
    );
  });

  it("a single task's critical path is its own time; a cloud fan-out has no idle slot", () => {
    const one = [{ id: "only", durationMs: 90_000 }];
    const report = fanoutPathReport({
      tasks: one,
      dependencies: new Map(),
      wallMs: 90_000,
      localSlots: null,
      isLocal: () => false,
    });
    expect(report.critical).toEqual({ path: ["only"], ms: 90_000 });
    expect(report.idleLocalSlotMs).toBeNull();
    expect(renderPathLine(report)).toBe(
      "\n\nCritical path 1m30s (tasks only), total work 1m30s.",
    );
  });

  it("ends on a dependency cycle and ignores tasks that did not run", () => {
    const cyclic = criticalPath(
      [
        { id: "x", durationMs: 1_000 },
        { id: "y", durationMs: 2_000 },
      ],
      new Map([
        ["x", ["y", "ghost"]],
        ["y", ["x"]],
      ]),
    );
    expect(cyclic.ms).toBe(3_000);
    expect(renderPathLine(fanoutPathReport({
      tasks: [],
      dependencies: new Map(),
      wallMs: 0,
      localSlots: 1,
      isLocal: () => true,
    }))).toBe("");
  });
});
