import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  addDiffStat,
  diffStatOfResult,
  rebaseDiffStats,
  sumDiffStats,
} from "./worker-diffstats.js";

describe("worker diffstats (ATO-1700)", () => {
  it("reads an ok write/edit's diffstat with its path, and nothing else", () => {
    const details = { path: "/w/a.ts", diffstat: { added: 3, removed: 1 } };
    expect(diffStatOfResult({ tool: "os.fs.edit", status: "ok", details })).toEqual({
      path: "/w/a.ts",
      added: 3,
      removed: 1,
    });
    expect(diffStatOfResult({ tool: "os.fs.write", status: "ok", details })).not.toBeNull();
    expect(diffStatOfResult({ tool: "os.fs.edit", status: "error", details })).toBeNull();
    expect(diffStatOfResult({ tool: "os.shell.run", status: "ok", details })).toBeNull();
    expect(diffStatOfResult({ tool: "os.fs.edit", status: "ok" })).toBeNull();
    expect(
      diffStatOfResult({ tool: "os.fs.edit", status: "ok", details: { path: "", diffstat: { added: 1, removed: 0 } } }),
    ).toBeNull();
    expect(
      diffStatOfResult({ tool: "os.fs.edit", status: "ok", details: { path: "/a", diffstat: { added: -1, removed: 0 } } }),
    ).toBeNull();
    expect(
      diffStatOfResult({ tool: "os.fs.edit", status: "ok", details: { path: "/a", diffstat: { added: 1.5, removed: 0 } } }),
    ).toBeNull();
  });

  it("two workers editing one file give one row with the sum", () => {
    const total = sumDiffStats([
      { diffstats: [{ path: "/w/a.ts", added: 3, removed: 1 }, { path: "/w/b.md", added: 4, removed: 0 }] },
      {},
      { diffstats: [{ path: "/w/a.ts", added: 2, removed: 2 }] },
    ]);
    expect(total).toEqual([
      { path: "/w/a.ts", added: 5, removed: 3 },
      { path: "/w/b.md", added: 4, removed: 0 },
    ]);
  });

  it("adds without changing the list it was given", () => {
    const before = [{ path: "/w/a.ts", added: 1, removed: 0 }];
    const after = addDiffStat(before, { path: "/w/a.ts", added: 1, removed: 1 });
    expect(after).toEqual([{ path: "/w/a.ts", added: 2, removed: 1 }]);
    expect(before).toEqual([{ path: "/w/a.ts", added: 1, removed: 0 }]);
  });

  it("rebases workspace paths to the folder and drops what the merge did not write", () => {
    const ws = join("/tmp", "run", "t0-one");
    const real = join("/home", "me", "project");
    const out = rebaseDiffStats(
      [
        { path: join(ws, "src", "a.ts"), added: 2, removed: 1 },
        { path: join(ws, "conflict.ts"), added: 1, removed: 0 },
        { path: join("/tmp", "run", "t1-two", "b.ts"), added: 1, removed: 0 },
        { path: ws, added: 0, removed: 0 },
      ],
      ws,
      real,
      [join("src", "a.ts"), join("src", "removed.ts")],
    );
    expect(out).toEqual([{ path: join(real, "src", "a.ts"), added: 2, removed: 1 }]);
  });
});
