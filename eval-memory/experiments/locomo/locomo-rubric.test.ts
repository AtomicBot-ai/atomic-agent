import { describe, expect, it } from "vitest";

import type { LocomoQuestion } from "./dataset.js";
import { buildLocomoJudgePrompt, buildLocomoRubric } from "./locomo-rubric.js";

function q(overrides: Partial<LocomoQuestion>): LocomoQuestion {
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

describe("buildLocomoRubric", () => {
  it("emits the recall rubric for categories 1..4", () => {
    for (const [cat, label] of [
      [1, "single_hop"],
      [2, "multi_hop"],
      [3, "temporal"],
      [4, "open_domain"],
    ] as const) {
      const r = buildLocomoRubric(
        q({ category: cat as 1 | 2 | 3 | 4, categoryLabel: label }),
      );
      expect(r).toContain("information recall");
      expect(r).toContain(label);
      expect(r).toContain("Gold answer (operator-authored): 7 May 2023");
      expect(r).toContain("Ignore differences in wording");
      expect(r).not.toContain("MUST DECLINE");
    }
  });

  it("emits the abstention rubric for category 5", () => {
    const r = buildLocomoRubric(
      q({
        category: 5,
        categoryLabel: "adversarial",
        answer: "I don't know",
        adversarialAnswer: "Not in the conversation.",
      }),
    );
    expect(r).toContain("adversarial");
    expect(r).toContain("must DECLINE");
    expect(r).toContain("Reference: Not in the conversation.");
    expect(r).toContain("Confidence without grounding");
  });

  it("falls back to a default reference when adversarialAnswer is null", () => {
    const r = buildLocomoRubric(
      q({
        category: 5,
        categoryLabel: "adversarial",
        answer: "I don't know",
        adversarialAnswer: null,
      }),
    );
    expect(r).toContain("I don't know based on the conversation.");
  });

  it("clips long gold answers to keep rubric size bounded", () => {
    const longGold = "A".repeat(1000);
    const r = buildLocomoRubric(q({ answer: longGold }), { goldEchoMaxChars: 50 });
    // 49 'A' chars + a horizontal ellipsis (1 char) = 50 visible chars after the prefix.
    expect(r).toMatch(/Gold answer \(operator-authored\): A{49}…/);
  });

  it("injects category-specific guidance into recall rubrics", () => {
    expect(buildLocomoRubric(q({ categoryLabel: "single_hop", category: 1 }))).toContain(
      "single-hop questions",
    );
    expect(buildLocomoRubric(q({ categoryLabel: "multi_hop", category: 2 }))).toContain(
      "multi-hop questions",
    );
    expect(buildLocomoRubric(q({ categoryLabel: "temporal", category: 3 }))).toContain(
      "temporal questions",
    );
    expect(buildLocomoRubric(q({ categoryLabel: "open_domain", category: 4 }))).toContain(
      "open-domain questions",
    );
  });

  it("keeps rubric size under ~1.5 KB for the default options", () => {
    const r = buildLocomoRubric(q({}));
    expect(r.length).toBeLessThan(1500);
  });
});

describe("buildLocomoJudgePrompt", () => {
  it("uses the LoCoMo question verbatim without runner-side filler", () => {
    const prompt = buildLocomoJudgePrompt(q({}));
    expect(prompt).toContain("When did Caroline visit the LGBTQ support group?");
    expect(prompt).not.toContain("Answer concisely from what you remember");
  });
});
