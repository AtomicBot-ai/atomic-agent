import { describe, expect, it } from "vitest";

import { descendantPids, descendantsFromTable } from "./process-descendants.js";

/** ATO-2277 review: a pty job's program runs in its own session under `script`. */
describe("descendantsFromTable", () => {
  it("walks the whole tree below the root, nearest first, and nothing else", () => {
    const table = [
      "  1     0",
      "100     1", // script (the job)
      "101   100", // bash, own session (setsid)
      "102   101", // nohup sleep &
      "103   102",
      "200     1", // unrelated
      "201   200",
    ].join("\n");
    expect(descendantsFromTable(100, table)).toEqual([101, 102, 103]);
    expect(descendantsFromTable(999, table)).toEqual([]);
  });

  it("skips malformed rows and survives a cycle", () => {
    expect(descendantsFromTable(5, "x y\n6 5\n5 6\n\n")).toEqual([6]);
  });

  it("is empty when ps cannot run", () => {
    expect(descendantPids(1, () => { throw new Error("no ps"); })).toEqual([]);
  });
});
