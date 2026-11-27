import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkFixtures, percentile, scoreLetter, summarize, type FixtureLetter } from "./score.js";

const fixture = (name: string): FixtureLetter[] =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/privacy-names/${name}.json`, import.meta.url)), "utf8"),
  ) as FixtureLetter[];

const LETTER: FixtureLetter = {
  id: "t-1",
  text: "Ask Mrs. Abernathy at Acme about the support ticket",
  spans: [
    { text: "Abernathy", kind: "NAME" },
    { text: "Acme", kind: "ORG" },
  ],
};

describe("privacy names benchmark scoring (ATO-2527)", () => {
  it("ships 25 English and 25 Russian letters, each span word for word in its text", () => {
    const en = fixture("en");
    const ru = fixture("ru");
    expect(en).toHaveLength(25);
    expect(ru).toHaveLength(25);
    expect(checkFixtures([...en, ...ru])).toEqual([]);
    // Some letters have nothing private: they measure false positives.
    expect(en.filter((l) => l.spans.length === 0).length).toBeGreaterThanOrEqual(5);
    expect(ru.filter((l) => l.spans.length === 0).length).toBeGreaterThanOrEqual(5);
  });

  it("counts a leak by what is still readable, and a false positive by overlap", () => {
    const score = scoreLetter(
      LETTER,
      [{ value: "Mrs. Abernathy" }, { value: "support" }],
      "Ask [NAME_1] at Acme about the [ORG_1] ticket",
      120,
    );
    expect(score).toMatchObject({ expected: 2, covered: 1, leaked: ["Acme"], found: 2, correct: 1, falsePositives: ["support"] });
  });

  it("summarizes recall, precision and latency", () => {
    const a = scoreLetter(LETTER, [{ value: "Abernathy" }, { value: "Acme" }], "Ask Mrs. [NAME_1] at [ORG_1]", 100);
    const b = scoreLetter({ id: "t-2", text: "nothing", spans: [] }, [], "nothing", 300, true);
    expect(summarize([a, b])).toEqual({
      letters: 2,
      expected: 2,
      covered: 2,
      recall: 1,
      found: 2,
      correct: 2,
      precision: 1,
      failedLetters: 1,
      latencyMs: { p50: 100, p95: 300, max: 300 },
    });
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });

  it("reports a span missing from its text", () => {
    expect(checkFixtures([{ id: "x", text: "hello", spans: [{ text: "Bob", kind: "NAME" }] }])).toEqual([
      'x: "Bob" is not in the text',
    ]);
  });
});
