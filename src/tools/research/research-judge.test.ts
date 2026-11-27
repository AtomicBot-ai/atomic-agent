import { describe, expect, it } from "vitest";
import { judgeContradictions, judgePrompt, MAX_JUDGED, readJudgement } from "./research-judge.js";
import { focusText } from "./research-sources.js";
import type { Contradiction, VerifiedFinding } from "./research-types.js";

const finding = (claim: string, url: string): VerifiedFinding => ({ subQuestion: 0, claim, quote: claim, url, derived: [] });
const flag = (i: number): Contradiction => ({
  subQuestion: 0,
  unit: "staff",
  a: finding(`A has ${i} staff.`, `https://a${i}.example/`),
  b: finding(`B has ${i * 10} staff.`, `https://b${i}.example/`),
  values: [`${i} staff`, `${i * 10} staff`],
});
const signal = new AbortController().signal;

describe("readJudgement (ATO-2507)", () => {
  it("accepts the three verdicts and folds the note to one bounded line", () => {
    expect(readJudgement({ verdict: "conflict", note: " Same year,\n same county. " })).toEqual({ verdict: "conflict", note: "Same year, same county." });
    expect(readJudgement({ verdict: "unclear", note: "x".repeat(400) })?.note).toHaveLength(300);
    expect(readJudgement({ verdict: "different_measures" })).toEqual({ verdict: "different_measures", note: "" });
  });

  it("refuses anything else", () => {
    for (const bad of [undefined, null, "conflict", [], { verdict: "maybe", note: "" }, { note: "n" }]) {
      expect(readJudgement(bad)).toBeNull();
    }
  });

  it("frames both quotes as data in the prompt", () => {
    const prompt = judgePrompt({ question: "q", subQuestion: "s", a: { claim: "ca", quote: "qa", source: "A" }, b: { claim: "cb", quote: "qb", source: "B" } });
    expect(prompt).toMatch(/<<<UNTRUSTED QUOTE A [0-9a-f]{16}>>>\nqa\n/);
    expect(prompt).toMatch(/<<<UNTRUSTED QUOTE B [0-9a-f]{16}>>>\nqb\n/);
    expect(prompt).toContain("Do not say which source is right.");
  });
});

describe("judgeContradictions (ATO-2507)", () => {
  it("judges at most MAX_JUDGED pairs and leaves the rest plain", async () => {
    let calls = 0;
    const flags = Array.from({ length: MAX_JUDGED + 2 }, (_, i) => flag(i + 1));
    const { contradictions, cut } = await judgeContradictions({
      question: "q", subQuestions: ["s"], contradictions: flags, ctx: { signal },
      judge: async () => { calls++; return { verdict: "conflict", note: "same" }; },
    });
    expect(calls).toBe(MAX_JUDGED);
    expect(cut).toBe(false);
    expect(contradictions.filter((c) => c.judgement !== undefined)).toHaveLength(MAX_JUDGED);
    expect(contradictions[MAX_JUDGED]!.judgement).toBeUndefined();
    // The input is not changed.
    expect(flags[0]!.judgement).toBeUndefined();
  });

  it("stops at the time limit and passes cancellation on", async () => {
    const { contradictions, cut } = await judgeContradictions({
      question: "q", subQuestions: ["s"], contradictions: [flag(1)], ctx: { signal }, timeUp: () => true,
      judge: async () => { throw new Error("must not be called"); },
    });
    expect(cut).toBe(true);
    expect(contradictions[0]!.judgement).toBeUndefined();
    const abort = new AbortController();
    await expect(judgeContradictions({
      question: "q", subQuestions: ["s"], contradictions: [flag(1)], ctx: { signal: abort.signal },
      judge: async () => { abort.abort(); throw new Error("aborted"); },
    })).rejects.toThrow("aborted");
  });
});

describe("focusText (ATO-2507)", () => {
  it("shows the model the part of a long document around its snippet", () => {
    const text = `${"filler words here. ".repeat(500)}The notice period is\nthirty days. ${"more filler. ".repeat(500)}`;
    const window = focusText(text, "«notice» period is thirty…", 1000);
    expect(window).toHaveLength(1000);
    expect(window).toContain("The notice period is\nthirty days.");
    expect(focusText("short", "anything", 1000)).toBe("short");
    expect(focusText(text, "not in the text at all", 1000)).toBe(text.slice(0, 1000));
  });
});
