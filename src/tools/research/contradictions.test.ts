import { describe, expect, it } from "vitest";
import { findContradictions } from "./contradictions.js";
import type { VerifiedFinding } from "./research-types.js";

const finding = (claim: string, url: string, subQuestion = 0): VerifiedFinding => ({
  subQuestion,
  claim,
  quote: claim,
  url,
  derived: [],
});

describe("findContradictions (ATO-2133)", () => {
  it("flags two sources on one sub-question that give different values for the same unit", () => {
    const a = finding("The city has 2.1 million residents.", "https://a.example/");
    const b = finding("The city has 3.4 million residents.", "https://b.example/");
    const found = findContradictions([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subQuestion: 0, a, b, values: ["2.1 million", "3.4 million"] });
  });

  it("compares scaled amounts by value: 1.2 million and 1.23 million agree, 2 billion does not", () => {
    const a = finding("Revenue was 1.2 million dollars.", "https://a.example/");
    const b = finding("Revenue was 1.23 million dollars.", "https://b.example/");
    expect(findContradictions([a, b])).toEqual([]);
    const c = finding("Revenue was 2 billion dollars.", "https://c.example/");
    expect(findContradictions([a, c])[0]?.values).toEqual(["1.2 million", "2 billion"]);
  });

  it("flags percentages more than 5% apart and keeps close ones together", () => {
    const far = findContradictions([
      finding("Adoption reached 40% of firms.", "https://a.example/"),
      finding("Adoption reached 25% of firms.", "https://b.example/"),
    ]);
    expect(far[0]?.values).toEqual(["40%", "25%"]);
    expect(findContradictions([
      finding("Adoption reached 40% of firms.", "https://a.example/"),
      finding("Adoption reached 41% of firms.", "https://b.example/"),
    ])).toEqual([]);
  });

  it("does not compare different sub-questions, the same page, or figures for different years", () => {
    expect(findContradictions([
      finding("It has 10 employees.", "https://a.example/", 0),
      finding("It has 90 employees.", "https://b.example/", 1),
    ])).toEqual([]);
    expect(findContradictions([
      finding("It has 10 employees.", "https://a.example/"),
      finding("It has 90 employees.", "https://a.example/"),
    ])).toEqual([]);
    expect(findContradictions([
      finding("In 2020 it had 10 employees.", "https://a.example/"),
      finding("In 2024 it had 90 employees.", "https://b.example/"),
    ])).toEqual([]);
  });

  it("ignores numbers followed by a filler word instead of a unit", () => {
    expect(findContradictions([
      finding("Ranked 3 in the list.", "https://a.example/"),
      finding("Ranked 9 in the list.", "https://b.example/"),
    ])).toEqual([]);
  });
});
