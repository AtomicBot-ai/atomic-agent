import { describe, expect, it } from "vitest";
import { parseFitTestArgs } from "./models-fit-test-command.js";

describe("parseFitTestArgs", () => {
  it("reads the flags", () => {
    const parsed = parseFitTestArgs([
      "--tasks", "t.json", "--models", "a, b,a", "--judge-url", "http://127.0.0.1:8080",
      "--judge-key-env", "JUDGE_KEY", "--timeout", "60", "--json",
    ]);
    expect(parsed).toMatchObject({
      modelIds: ["a", "b"],
      judgeUrl: "http://127.0.0.1:8080",
      judgeModel: "judge",
      judgeKeyEnv: "JUDGE_KEY",
      timeoutMs: 60_000,
      outPath: null,
      json: true,
    });
  });

  it("requires a task file, models and a judge, and caps the models at three", () => {
    expect(parseFitTestArgs(["--models", "a", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/--tasks/) });
    expect(parseFitTestArgs(["--tasks", "t", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/--models/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a"])).toMatchObject({ error: expect.stringMatching(/--judge-url/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a,b,c,d", "--judge-url", "u"])).toMatchObject({ error: expect.stringMatching(/at most 3/) });
    expect(parseFitTestArgs(["--tasks", "t", "--models", "a", "--judge-url", "u", "--timeout", "0"])).toMatchObject({ error: expect.stringMatching(/--timeout/) });
  });
});
