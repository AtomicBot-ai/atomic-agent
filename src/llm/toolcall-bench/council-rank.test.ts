import { describe, expect, it } from "vitest";

import { aggregateRankings, buildRankPrompt, parseRanking, rankBallot } from "./council-rank.js";
import type { CouncilMember } from "./model-council.js";

const MEMBERS: CouncilMember[] = [
  { label: "A", model: "or:a", text: "Use Postgres." },
  { label: "B", model: "or:b", text: "Use SQLite." },
  { label: "C", model: "or:c", text: "Use DuckDB." },
];

describe("rankBallot / buildRankPrompt (ATO-2432)", () => {
  it("leaves the ranker's own answer out and reletters the rest from A", () => {
    const ballot = rankBallot("or:a", MEMBERS);
    expect(ballot.lettered).toEqual([
      { label: "A", model: "or:b", text: "Use SQLite." },
      { label: "B", model: "or:c", text: "Use DuckDB." },
    ]);
    const prompt = buildRankPrompt("Which db?", ballot);
    expect(prompt).not.toContain("Use Postgres.");
    expect(prompt).not.toContain("or:b");
    expect(prompt).toContain("### Answer A\nUse SQLite.");
    expect(prompt).toContain("FINAL RANKING:\n1. Answer A\n2. Answer B");
  });
});

describe("parseRanking", () => {
  const ballot = rankBallot("or:a", MEMBERS);

  it("reads the FINAL RANKING block, not the comments before it", () => {
    const reply = "Answer A is short. Answer B is better.\n\nFINAL RANKING:\n1. Answer B\n2. Answer A";
    expect(parseRanking(reply, ballot)).toEqual(["or:c", "or:b"]);
  });

  it("reads bare letters, drops unknown and repeated ones", () => {
    expect(parseRanking("FINAL RANKING:\n1. B\n2. Z\n3. B\n4. A", ballot)).toEqual(["or:c", "or:b"]);
  });

  it("falls back to the answers named in order, and ignores a lowercase article", () => {
    expect(parseRanking("I would answer a question like this: Answer B, then Answer A.", ballot)).toEqual([
      "or:c",
      "or:b",
    ]);
    expect(parseRanking("no idea", ballot)).toEqual([]);
  });
});

describe("aggregateRankings", () => {
  it("averages places per member, best first, ties in the named order", () => {
    const standings = aggregateRankings(
      [
        { ranker: "or:a", order: ["or:c", "or:b"] },
        { ranker: "or:b", order: ["or:c", "or:a"] },
        { ranker: "or:c", order: ["or:a", "or:b"] },
        { ranker: "x", order: [], error: "failed" },
      ],
      MEMBERS,
    );
    expect(standings).toEqual([
      { model: "or:c", averageRank: 1, votes: 2 },
      { model: "or:a", averageRank: 1.5, votes: 2 },
      { model: "or:b", averageRank: 2, votes: 2 },
    ]);
  });
});
