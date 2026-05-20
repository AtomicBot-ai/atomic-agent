import { describe, expect, it } from "vitest";

import type {
  JudgeClient,
  JudgeInput,
  JudgeVerdict,
} from "../../harness/judge.js";
import type { LocomoQuestion } from "./dataset.js";
import {
  alignVerdictsWithRunner,
  judgeLocomoResults,
  summariseJudgeByCategory,
} from "./locomo-judge.js";

function makeQuestion(overrides: Partial<LocomoQuestion>): LocomoQuestion {
  return {
    question: "When did Caroline visit the LGBTQ support group?",
    answer: "7 May 2023",
    category: 1,
    categoryLabel: "single_hop",
    evidence: [],
    adversarialAnswer: null,
    ...overrides,
  };
}

function makeJudge(impl: (input: JudgeInput) => JudgeVerdict | Promise<JudgeVerdict>): JudgeClient {
  return {
    async score(input) {
      return impl(input);
    },
  };
}

describe("judgeLocomoResults", () => {
  it("returns one verdict per input, in input order", async () => {
    const inputs = [0, 1, 2].map((i) => ({
      profile: "full_v2" as const,
      conversationId: "conv-26",
      question: makeQuestion({ question: `q${i}` }),
      reply: `reply ${i}`,
    }));
    const judge = makeJudge((input) => ({
      score: 4,
      reason: `seen ${input.reply}`,
      durationMs: 1,
      raw: "{}",
      parseFallback: false,
    }));
    const verdicts = await judgeLocomoResults({ judge, inputs, concurrency: 2 });
    expect(verdicts.map((v) => v.question)).toEqual(["q0", "q1", "q2"]);
    expect(verdicts.every((v) => v.score === 4 && v.available)).toBe(true);
  });

  it("floors empty replies to score 1 without invoking the judge", async () => {
    let judgeCalls = 0;
    const judge = makeJudge(() => {
      judgeCalls += 1;
      return {
        score: 5,
        reason: "should not be called",
        durationMs: 1,
        raw: "{}",
        parseFallback: false,
      };
    });
    const verdicts = await judgeLocomoResults({
      judge,
      inputs: [
        {
          profile: "full_v2",
          conversationId: "conv-26",
          question: makeQuestion({}),
          reply: "",
        },
      ],
    });
    expect(judgeCalls).toBe(0);
    expect(verdicts[0]?.score).toBe(1);
    expect(verdicts[0]?.available).toBe(true);
    expect(verdicts[0]?.reason).toContain("empty reply");
  });

  it("treats judge throws as availability failures, score floored to 1", async () => {
    const judge = makeJudge(() => {
      throw new Error("HTTP 503");
    });
    const verdicts = await judgeLocomoResults({
      judge,
      retries: 0,
      inputs: [
        {
          profile: "full_v2",
          conversationId: "conv-26",
          question: makeQuestion({}),
          reply: "May 7, 2023",
        },
      ],
    });
    expect(verdicts[0]?.score).toBe(1);
    expect(verdicts[0]?.available).toBe(false);
    expect(verdicts[0]?.reason).toContain("judge unavailable");
    expect(verdicts[0]?.reason).toContain("HTTP 503");
  });

  it("marks parseFallback verdicts as unavailable but preserves the score", async () => {
    const judge = makeJudge(() => ({
      score: 3,
      reason: "fallback parse",
      durationMs: 5,
      raw: "garbage",
      parseFallback: true,
    }));
    const verdicts = await judgeLocomoResults({
      judge,
      inputs: [
        {
          profile: "full_v2",
          conversationId: "conv-26",
          question: makeQuestion({}),
          reply: "May 7, 2023",
        },
      ],
    });
    expect(verdicts[0]?.score).toBe(3);
    expect(verdicts[0]?.available).toBe(false);
  });

  it("honours the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const judge = makeJudge(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return {
        score: 5,
        reason: "",
        durationMs: 5,
        raw: "{}",
        parseFallback: false,
      };
    });
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      profile: "full_v2" as const,
      conversationId: "conv-26",
      question: makeQuestion({ question: `q${i}` }),
      reply: "x",
    }));
    await judgeLocomoResults({ judge, inputs, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("summariseJudgeByCategory", () => {
  it("rolls up mean/judgeAcc per (profile, category)", () => {
    const verdicts = [
      verdict("full_v2", "single_hop", 5, true),
      verdict("full_v2", "single_hop", 4, true),
      verdict("full_v2", "single_hop", 2, true),
      verdict("full_v2", "multi_hop", 1, false),
      verdict("none", "single_hop", 3, true),
    ];
    const summary = summariseJudgeByCategory(verdicts);
    expect(summary).toHaveLength(3);
    const fullSingle = summary.find(
      (s) => s.profile === "full_v2" && s.category === "single_hop",
    )!;
    expect(fullSingle.graded).toBe(3);
    expect(fullSingle.judgeAvailable).toBe(3);
    expect(fullSingle.meanJudgeScore).toBeCloseTo((5 + 4 + 2) / 3, 5);
    expect(fullSingle.judgeAccAtFour).toBeCloseTo(2 / 3, 5);
    expect(fullSingle.judgeAccAtFive).toBeCloseTo(1 / 3, 5);

    const fullMulti = summary.find(
      (s) => s.profile === "full_v2" && s.category === "multi_hop",
    )!;
    expect(fullMulti.judgeAvailable).toBe(0);
    expect(fullMulti.meanJudgeScore).toBe(1);
  });
});

describe("alignVerdictsWithRunner", () => {
  it("pairs verdicts with the runner result by (profile, conv, question)", () => {
    const verdict = {
      conversationId: "conv-26",
      profile: "full_v2" as const,
      category: "single_hop" as const,
      question: "What did Caroline research?",
      goldAnswer: "Adoption agencies",
      reply: "Adoption agencies and later counselling.",
      score: 5,
      reason: "ok",
      available: true,
      durationMs: 1,
    };
    const runnerResult = {
      conversationId: "conv-26",
      profile: "full_v2" as const,
      category: "single_hop" as const,
      question: "What did Caroline research?",
      goldAnswer: "Adoption agencies",
      adversarial: false,
      assistantReply: "Adoption agencies",
      substringMatch: 1,
      abstainCorrect: 1,
      stepCount: 2,
      durationMs: 14000,
      promptTokens: 9800,
      predictedTokens: 18,
    };
    const aligned = alignVerdictsWithRunner([verdict], [runnerResult]);
    expect(aligned).toHaveLength(1);
    expect(aligned[0]?.[1]?.substringMatch).toBe(1);
  });

  it("returns null when no runner result matches", () => {
    const verdict = {
      conversationId: "conv-26",
      profile: "full_v2" as const,
      category: "single_hop" as const,
      question: "missing",
      goldAnswer: "x",
      reply: "y",
      score: 3,
      reason: "",
      available: true,
      durationMs: 0,
    };
    const aligned = alignVerdictsWithRunner([verdict], []);
    expect(aligned[0]?.[1]).toBeNull();
  });
});

function verdict(
  profile: "full_v2" | "none",
  category: "single_hop" | "multi_hop",
  score: number,
  available: boolean,
) {
  return {
    conversationId: "conv-26",
    profile,
    category,
    question: `${profile}-${category}-${score}`,
    goldAnswer: "x",
    reply: "y",
    score,
    reason: "",
    available,
    durationMs: 1,
  };
}
