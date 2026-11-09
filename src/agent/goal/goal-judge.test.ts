import { describe, expect, it } from "vitest";

import {
  buildGoalJudgePrompt,
  buildGoalJudgeRequest,
  extractGoalJudgeText,
  parseGoalVerdict,
} from "./goal-judge.js";

describe("parseGoalVerdict", () => {
  it("reads one verdict per criterion, in order", () => {
    const text = JSON.stringify({
      criteria: [
        { index: 2, verdict: "not_met", reason: "no test for the edge case" },
        { index: 1, verdict: "met", reason: "tests pass" },
      ],
    });
    expect(parseGoalVerdict(text, 2)).toEqual([
      { mark: "met", reason: "tests pass" },
      { mark: "not_met", reason: "no test for the edge case" },
    ]);
  });

  it("tolerates reasoning blocks, code fences and spelling variants", () => {
    const text = "<think>let me see</think>\n```json\n" +
      '{"criteria":[{"index":1,"verdict":"Not met","reason":"a"},{"index":2,"verdict":"BLOCKED","reason":"needs a key"}]}\n```';
    expect(parseGoalVerdict(text, 2)?.map((v) => v.mark)).toEqual(["not_met", "blocked"]);
  });

  it("rejects prose, missing items and unknown verdicts", () => {
    expect(parseGoalVerdict("all good!", 1)).toBeNull();
    expect(parseGoalVerdict('{"criteria":[{"index":1,"verdict":"met"}]}', 2)).toBeNull();
    expect(parseGoalVerdict('{"criteria":[{"index":1,"verdict":"probably"}]}', 1)).toBeNull();
    expect(parseGoalVerdict('{"verdict":"met"}', 1)).toBeNull();
  });
});

describe("judge request", () => {
  it("lists the criteria, the checks and the reply in the prompt", () => {
    const prompt = buildGoalJudgePrompt({
      criteria: ["tests pass", "README updated"],
      reply: "I ran npm test: 42 passed. Updated README.",
      checks: [{ command: "npm test", passed: true, exitCode: 0, timedOut: false, output: "" }],
    });
    expect(prompt).toContain("1. tests pass");
    expect(prompt).toContain("2. README updated");
    expect(prompt).toContain("- npm test: passed");
    expect(prompt).toContain("42 passed");
    expect(prompt).toContain("exactly 2 entries");
  });

  it("uses one emit function on a cloud link and the chat template locally", () => {
    const cloud = buildGoalJudgeRequest({
      prompt: "p", sessionId: "s1", transport: "native_tools", slotId: 3, serverTemplate: true,
    });
    expect(JSON.stringify(cloud.tools)).toContain("emit_goal_verdict");
    expect(cloud.slotId).toBe(-1);
    expect(cloud.sessionId).toBe("goal-judge:s1");

    const local = buildGoalJudgeRequest({
      prompt: "p", sessionId: "s1", transport: "grammar", slotId: 3, serverTemplate: true,
    });
    expect(local.tools).toBeUndefined();
    expect(local.slotId).toBe(3);
    expect(local.chat?.enableThinking).toBe(false);
  });

  it("reads the verdict from tool arguments before the prose", () => {
    expect(extractGoalJudgeText({
      content: "",
      toolCalls: [{ id: "1", type: "function", function: { name: "emit_goal_verdict", arguments: '{"criteria":[]}' } }],
    })).toBe('{"criteria":[]}');
    expect(extractGoalJudgeText({ content: "plain" })).toBe("plain");
  });
});
