import { describe, expect, it } from "vitest";
import {
  placeOnboardingBlock,
  widestLine,
  type OnboardingBlockPlacement,
} from "./centre-onboarding-block.js";

const PADDING_LEFT = 2;
const PADDING_TOP = 1;
const FOOTER_ROWS = 1;

function place(
  columns: number,
  rows: number,
  blockWidth: number,
): OnboardingBlockPlacement {
  return placeOnboardingBlock({
    columns,
    rows,
    blockWidth,
    paddingLeft: PADDING_LEFT,
    paddingTop: PADDING_TOP,
    footerRows: FOOTER_ROWS,
  });
}

describe("placeOnboardingBlock", () => {
  const cases: {
    name: string;
    columns: number;
    rows: number;
    blockWidth: number;
    expected: OnboardingBlockPlacement;
  }[] = [
    {
      name: "a roomy window",
      columns: 120,
      rows: 40,
      blockWidth: 60,
      expected: { left: 28, width: 60, rows: 38 },
    },
    {
      name: "the size the flow asks for",
      columns: 100,
      rows: 30,
      blockWidth: 76,
      expected: { left: 10, width: 76, rows: 28 },
    },
    {
      name: "an odd remainder, rounded towards the left",
      columns: 100,
      rows: 30,
      blockWidth: 75,
      expected: { left: 10, width: 75, rows: 28 },
    },
    {
      name: "a block that exactly fills the room it has",
      columns: 80,
      rows: 24,
      blockWidth: 78,
      expected: { left: 0, width: 78, rows: 22 },
    },
    {
      name: "a block one column too wide",
      columns: 80,
      rows: 24,
      blockWidth: 79,
      expected: { left: 0, width: 78, rows: 22 },
    },
    {
      name: "a block far too wide to centre",
      columns: 60,
      rows: 24,
      blockWidth: 120,
      expected: { left: 0, width: 58, rows: 22 },
    },
    {
      name: "a window too short for anything but the hint strip",
      columns: 100,
      rows: 1,
      blockWidth: 40,
      expected: { left: 28, width: 40, rows: 0 },
    },
    {
      name: "no terminal at all",
      columns: 0,
      rows: 0,
      blockWidth: 40,
      expected: { left: 0, width: 0, rows: 0 },
    },
  ];

  for (const testCase of cases) {
    it(`places the block in ${testCase.name}`, () => {
      expect(place(testCase.columns, testCase.rows, testCase.blockWidth)).toEqual(
        testCase.expected,
      );
    });
  }

  it("balances the block on the window, not on the inset box it sits in", () => {
    const columns = 120;
    const placement = place(columns, 40, 50);
    const leftGap = PADDING_LEFT + placement.left;
    const rightGap = columns - leftGap - placement.width;
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
  });

  it("never hands back a margin that would push the block off the left edge", () => {
    for (let columns = 1; columns <= 40; columns += 1) {
      const placement = place(columns, 24, 80);
      expect(placement.left).toBe(0);
      expect(placement.width).toBeLessThanOrEqual(Math.max(0, columns - PADDING_LEFT));
    }
  });
});

describe("widestLine", () => {
  it("measures the widest line and ignores the pad cells that align columns", () => {
    expect(widestLine(["ab", "abcd", "abc"])).toBe(4);
    expect(widestLine(["short".padEnd(40), "a bit longer"])).toBe(12);
    expect(widestLine([])).toBe(0);
  });
});
