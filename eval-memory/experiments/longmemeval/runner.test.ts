import { describe, it, expect } from "vitest";

import { summariseByAxis } from "./runner.js";
import type { LongMemEvalRowResult } from "./runner.js";

function makeRow(
  profile: "fts5_only" | "full_v2",
  axis: "knowledge_updates" | "abstention",
  substring: number,
  abstain: number,
): LongMemEvalRowResult {
  return {
    questionId: "q",
    profile,
    sessionsFed: 1,
    question: {
      questionId: "q",
      profile,
      axis,
      questionType: "x",
      question: "q?",
      goldAnswer: "g",
      isAbstention: axis === "abstention",
      assistantReply: "r",
      substringMatch: substring,
      abstainCorrect: abstain,
      stepCount: 2,
      durationMs: 500,
      promptTokens: 1000,
      predictedTokens: 50,
    },
    loadPhaseDurationMs: 3000,
    loadPhasePromptTokens: 5000,
    ok: true,
  };
}

describe("summariseByAxis", () => {
  it("aggregates per (profile, axis) and averages metrics", () => {
    const results: LongMemEvalRowResult[] = [
      makeRow("fts5_only", "knowledge_updates", 1, 1),
      makeRow("fts5_only", "knowledge_updates", 0, 0),
      makeRow("fts5_only", "abstention", 0, 0),
      makeRow("fts5_only", "abstention", 0, 0),
      makeRow("full_v2", "knowledge_updates", 1, 1),
      makeRow("full_v2", "knowledge_updates", 1, 1),
      makeRow("full_v2", "abstention", 0, 1),
      makeRow("full_v2", "abstention", 0, 1),
    ];
    const summary = summariseByAxis(results);
    const ftsKu = summary.find(
      (s) => s.profile === "fts5_only" && s.axis === "knowledge_updates",
    )!;
    expect(ftsKu.substringAccuracy).toBeCloseTo(0.5);
    const fullKu = summary.find(
      (s) => s.profile === "full_v2" && s.axis === "knowledge_updates",
    )!;
    expect(fullKu.substringAccuracy).toBeCloseTo(1);
    const fullAbst = summary.find(
      (s) => s.profile === "full_v2" && s.axis === "abstention",
    )!;
    expect(fullAbst.abstentionAccuracy).toBeCloseTo(1);
    const ftsAbst = summary.find(
      (s) => s.profile === "fts5_only" && s.axis === "abstention",
    )!;
    expect(ftsAbst.abstentionAccuracy).toBeCloseTo(0);
  });

  it("returns an empty array on empty input", () => {
    expect(summariseByAxis([])).toEqual([]);
  });
});
