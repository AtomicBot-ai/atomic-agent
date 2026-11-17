import { describe, expect, it } from "vitest";

import { askManyModels } from "./ask-many-models.js";
import { formatAnswers, formatBenchTable } from "./format-bench.js";

describe("askManyModels (ATO-1092)", () => {
  it("asks every model concurrently and keeps the named order", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const pending = askManyModels({
      models: ["slow", "fast"],
      prompt: "2+2?",
      complete: (model, prompt) => {
        started.push(`${model}:${prompt}`);
        return new Promise((resolve) => release.push(() => resolve(`${model} says 4`)));
      },
      now: () => 0,
    });
    await Promise.resolve();
    expect(started).toEqual(["slow:2+2?", "fast:2+2?"]);
    release[1]!();
    release[0]!();
    expect(await pending).toEqual([
      { model: "slow", text: "slow says 4", ms: 0 },
      { model: "fast", text: "fast says 4", ms: 0 },
    ]);
  });

  it("keeps a failed model as an error instead of failing the rest", async () => {
    const answers = await askManyModels({
      models: ["ok", "down"],
      prompt: "hi",
      complete: async (model) => {
        if (model === "down") throw new Error("401 bad key");
        return "hello";
      },
      now: () => 0,
    });
    expect(answers[1]).toEqual({ model: "down", error: "401 bad key", ms: 0 });
    expect(formatAnswers(answers)).toBe("== ok (0 ms) ==\nhello\n\n== down (0 ms) ==\nerror: 401 bad key\n");
  });
});

describe("formatBenchTable", () => {
  it("prints shares per model, the cases a model missed and its first error", () => {
    const text = formatBenchTable([
      {
        model: "or:a",
        tries: 4,
        validJson: 3,
        rightTool: 2,
        argsOk: 1,
        parseFailures: 1,
        noCall: 0,
        errors: 0,
        avgMs: 120,
        okByCase: { read: 1, write: 0 },
      },
      {
        model: "or:b",
        tries: 4,
        validJson: 0,
        rightTool: 0,
        argsOk: 0,
        parseFailures: 0,
        noCall: 0,
        errors: 4,
        avgMs: 5,
        okByCase: { read: 0, write: 0 },
        firstError: "timeout",
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^model\s+tries\s+json\s+tool\s+args\s+parse\s+no call\s+errors\s+avg ms$/);
    expect(lines[1]).toMatch(/^or:a\s+4\s+75%\s+50%\s+25%\s+1\s+0\s+0\s+120$/);
    expect(text).toContain("or:a missed: read 1/2, write 0/2");
    expect(text).toContain("or:b: timeout");
  });
});
