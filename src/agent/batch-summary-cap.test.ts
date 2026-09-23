import { describe, expect, it } from "vitest";
import { capBatchSummaries, fairShare } from "./batch-summary-cap.js";

const file = (name: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `// ${name} line ${i + 1} ${"x".repeat(30)}`,
  ).join("\n");

describe("capBatchSummaries", () => {
  it("returns summaries untouched when the batch fits", () => {
    const results = [
      { tool: "os.fs.list", summary: "a" },
      { tool: "os.fs.read", summary: "b" },
    ];
    expect(capBatchSummaries(results, [{}, {}], 1_000)).toEqual(["a", "b"]);
  });

  it("never erases a result: every file read keeps its head and the offset of the rest", () => {
    const names = ["main.js", "ship.js", "asteroids.js", "hud.js", "scene.js"];
    const results = names.map((n) => ({
      tool: "os.fs.read",
      summary: file(n, 110),
    }));
    const calls = names.map((n) => ({ args: { path: `js/${n}` } }));

    const out = capBatchSummaries(results, calls, 16_000);

    expect(out.reduce((acc, s) => acc + s.length, 0)).toBeLessThanOrEqual(
      16_000,
    );
    expect(out).not.toContain("[truncated]");
    out.forEach((s, i) => {
      expect(s.startsWith(`// ${names[i]} line 1 `)).toBe(true);
      const hint = /prompt shows the first (\d+) lines[^\]]*offset: (\d+)/.exec(
        s,
      );
      expect(hint).not.toBeNull();
      expect(Number(hint![2])).toBe(Number(hint![1]) + 1);
    });
  });

  it("lets short results keep their full text and clips only the one over its share", () => {
    const out = capBatchSummaries(
      [
        { tool: "os.fs.list", summary: "a".repeat(500) },
        { tool: "os.shell.run", summary: "b".repeat(500) },
        { tool: "os.shell.run", summary: "y".repeat(20_000) },
      ],
      [{}, {}, {}],
      4_000,
    );
    expect(out[0]).toBe("a".repeat(500));
    expect(out[1]).toBe("b".repeat(500));
    expect(out[2]!.length).toBeLessThanOrEqual(3_000);
    expect(out[2]).toContain(
      "more chars not shown: this step's results share a 4000-char budget",
    );
  });

  it("names the offset after the range a read started at", () => {
    const out = capBatchSummaries(
      [
        { tool: "os.fs.read", summary: file("a", 200) },
        { tool: "os.fs.read", summary: file("b", 200) },
      ],
      [{ args: { path: "a", offset: 50 } }, { args: { path: "b" } }],
      4_000,
    );
    const shown = Number(/prompt shows the first (\d+) lines/.exec(out[0]!)![1]);
    expect(out[0]).toContain(`offset: ${50 + shown}`);
  });
});

describe("fairShare", () => {
  it("splits evenly among results over the share and passes unused room on", () => {
    expect(fairShare([5_000, 5_000, 5_000, 5_000], 16_000)).toBe(4_000);
    expect(fairShare([1_000, 10_000, 10_000], 16_000)).toBe(7_500);
  });

  it("does not go below the minimum share for very wide batches", () => {
    expect(fairShare(Array<number>(40).fill(5_000), 16_000)).toBe(600);
  });
});
