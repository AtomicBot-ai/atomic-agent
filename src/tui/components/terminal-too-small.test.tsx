import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import {
  isTerminalTooSmall,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
} from "../layout.js";
import { planLines, TerminalTooSmall } from "./terminal-too-small.js";

function lines(frame: string): string[] {
  return frame
    .replace(/\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
}

/**
 * Every size a window can be dragged to, including the ones a person
 * only reaches by accident. The card exists because Ink 7 overlaps a
 * frame taller than the terminal rather than clipping it — so a
 * "terminal too small" card that itself overflowed would reproduce the
 * exact bug it was written to replace.
 */
const SIZES: ReadonlyArray<{ columns: number; rows: number }> = [
  { columns: 39, rows: 15 },
  { columns: 40, rows: 15 },
  { columns: 39, rows: 16 },
  { columns: 30, rows: 10 },
  { columns: 24, rows: 8 },
  { columns: 20, rows: 5 },
  { columns: 20, rows: 4 },
  { columns: 18, rows: 3 },
  { columns: 12, rows: 2 },
  { columns: 10, rows: 1 },
  { columns: 4, rows: 1 },
  { columns: 1, rows: 1 },
];

describe("TerminalTooSmall", () => {
  it.each(SIZES)("fits a $columns x $rows window", ({ columns, rows }) => {
    const { lastFrame } = render(
      <Box width={columns}>
        <TerminalTooSmall columns={columns} rows={rows} />
      </Box>,
    );
    const rendered = lines(lastFrame() ?? "");
    const widest = rendered.reduce((acc, line) => Math.max(acc, line.length), 0);
    expect(widest, `overflowed ${columns} columns`).toBeLessThanOrEqual(columns);
    expect(rendered.length, `overflowed ${rows} rows`).toBeLessThanOrEqual(rows);
  });

  it("says what is needed and what there is", () => {
    const { lastFrame } = render(
      <Box width={40}>
        <TerminalTooSmall columns={30} rows={10} />
      </Box>,
    );
    const body = lines(lastFrame() ?? "").join("\n");
    expect(body).toContain("terminal too small");
    expect(body).toContain(`needs ${MIN_TERMINAL_COLUMNS}x${MIN_TERMINAL_ROWS}`);
    expect(body).toContain("this one is 30x10");
  });

  it("keeps the numbers longest, and the title first", () => {
    // The ladder drops the least useful line at each step. On one row
    // the title goes: someone staring at a single line of an app that
    // has visibly stopped working already knows something is wrong, and
    // the size is the part they cannot guess.
    expect(planLines(4, "40x16", "20x5")).toEqual([
      "terminal too small",
      "",
      "needs 40x16",
      "this one is 20x5",
    ]);
    expect(planLines(3, "40x16", "20x5")).toHaveLength(3);
    expect(planLines(2, "40x16", "20x5")).toEqual([
      "terminal too small",
      "needs 40x16",
    ]);
    expect(planLines(1, "40x16", "20x5")).toEqual(["40x16 needed"]);
  });
});

describe("isTerminalTooSmall", () => {
  it("draws the line where the layout stops shrinking", () => {
    // 16 rows is not a preference. Rendered against a mocked terminal
    // size, the main screen comes out at 16 rows for a 16-row terminal
    // — and at 16 rows for a 14-, 12-, 8- and 5-row one. Below the
    // floor the frame does not get smaller, it gets painted over the
    // top of itself.
    expect(MIN_TERMINAL_ROWS).toBe(16);
    expect(isTerminalTooSmall(40, 16)).toBe(false);
    expect(isTerminalTooSmall(40, 15)).toBe(true);
    expect(isTerminalTooSmall(39, 16)).toBe(true);
    expect(isTerminalTooSmall(120, 40)).toBe(false);
    expect(isTerminalTooSmall(80, 24)).toBe(false);
  });
});
