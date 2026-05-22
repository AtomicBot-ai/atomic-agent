import { describe, it, expect } from "vitest";

import { summariseByCategory } from "./runner.js";
import type { LocomoConversationResult } from "./runner.js";

function makeQ(
  profile: "fts5_only" | "hybrid",
  category: "single_hop" | "multi_hop",
  substring: number,
  abstain: number,
) {
  return {
    conversationId: "c1",
    profile,
    category,
    question: "q",
    goldAnswer: "g",
    adversarial: false,
    assistantReply: "r",
    substringMatch: substring,
    abstainCorrect: abstain,
    stepCount: 3,
    durationMs: 1000,
    promptTokens: 500,
    predictedTokens: 200,
  } as const;
}

describe("summariseByCategory", () => {
  it("buckets by (profile, category) and averages metrics", () => {
    const results: LocomoConversationResult[] = [
      {
        conversationId: "c1",
        profile: "fts5_only",
        sessionsFed: 2,
        questionsAsked: 4,
        questions: [
          makeQ("fts5_only", "single_hop", 1, 1),
          makeQ("fts5_only", "single_hop", 0, 0),
          makeQ("fts5_only", "multi_hop", 1, 1),
          makeQ("fts5_only", "multi_hop", 0, 0),
        ],
        loadPhaseDurationMs: 5000,
        loadPhasePromptTokens: 2000,
        ok: true,
      },
      {
        conversationId: "c1",
        profile: "hybrid",
        sessionsFed: 2,
        questionsAsked: 4,
        questions: [
          makeQ("hybrid", "single_hop", 1, 1),
          makeQ("hybrid", "single_hop", 1, 1),
          makeQ("hybrid", "multi_hop", 1, 1),
          makeQ("hybrid", "multi_hop", 0, 0),
        ],
        loadPhaseDurationMs: 5000,
        loadPhasePromptTokens: 2000,
        ok: true,
      },
    ];
    const summary = summariseByCategory(results);
    expect(summary).toHaveLength(4);
    const ftsSingle = summary.find(
      (s) => s.profile === "fts5_only" && s.category === "single_hop",
    )!;
    expect(ftsSingle.questions).toBe(2);
    expect(ftsSingle.substringAccuracy).toBeCloseTo(0.5);
    const hybridSingle = summary.find(
      (s) => s.profile === "hybrid" && s.category === "single_hop",
    )!;
    expect(hybridSingle.substringAccuracy).toBeCloseTo(1.0);
    const hybridMulti = summary.find(
      (s) => s.profile === "hybrid" && s.category === "multi_hop",
    )!;
    expect(hybridMulti.substringAccuracy).toBeCloseTo(0.5);
  });

  it("returns an empty array when no questions ran", () => {
    expect(summariseByCategory([])).toEqual([]);
  });
});
