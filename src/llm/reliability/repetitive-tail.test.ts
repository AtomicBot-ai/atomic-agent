import { describe, expect, it } from "vitest";
import { hasRepetitiveTail, repetitiveTailPeriod } from "./repetitive-tail.js";

describe("hasRepetitiveTail", () => {
  it("catches a short block repeated until the cap", () => {
    expect(hasRepetitiveTail(`{"path":"a.ts","content":"${'}]"}]'.repeat(200)}`)).toBe(true);
  });

  it("catches a repeated line of code after real content", () => {
    const line = "        result.push(value.toString());\n";
    expect(hasRepetitiveTail(`function build() {\n${line.repeat(40)}`)).toBe(true);
  });

  it("ignores trailing whitespace when looking for the loop", () => {
    expect(hasRepetitiveTail(`${"abc ".repeat(100)}   \n`)).toBe(true);
  });

  it("does not flag ordinary text or rows that differ", () => {
    const rows = Array.from(
      { length: 200 },
      (_, i) => `| row ${i} | value ${i * 7} |\n`,
    ).join("");
    expect(hasRepetitiveTail(rows)).toBe(false);
  });

  it("does not flag a block repeated fewer than four times", () => {
    // 97-char block, three times: about 290 chars, under the 388 four repeats need.
    const block = "Let me read the regulations first, then draft the summary section by section, one part per step. ";
    expect(block.length).toBe(97);
    expect(hasRepetitiveTail(block.repeat(3))).toBe(false);
    expect(hasRepetitiveTail(block.repeat(5))).toBe(true);
  });

  it("does not flag text shorter than the minimum span", () => {
    expect(hasRepetitiveTail("ab".repeat(50))).toBe(false);
  });

  it("reports the period of the loop and honours a higher repeat count", () => {
    const block = "Let me read the regulations first, then draft the summary section by section, one part per step. ";
    expect(repetitiveTailPeriod(block.repeat(5), 4)).toBe(block.length);
    expect(repetitiveTailPeriod(block.repeat(5), 8)).toBeNull();
    expect(repetitiveTailPeriod(block.repeat(9), 8)).toBe(block.length);
  });
});
