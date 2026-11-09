import { describe, expect, it } from "vitest";

import { parseGoalCommand, splitGoalItems } from "./goal-command.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("parseGoalCommand", () => {
  it("splits a single line on ';' and a block on lines", () => {
    expect(parseGoalCommand("tests pass; README updated ;")).toEqual({
      kind: "set", criteria: ["tests pass", "README updated"], checks: [],
    });
    expect(parseGoalCommand("- tests pass; with coverage\n2. README updated\n\n")).toEqual({
      kind: "set", criteria: ["tests pass; with coverage", "README updated"], checks: [],
    });
  });

  it("takes `check:` items as shell checks", () => {
    expect(parseGoalCommand("tests pass; check: npm test; CHECK:npm run lint")).toEqual({
      kind: "set", criteria: ["tests pass"], checks: ["npm test", "npm run lint"],
    });
    expect(parseGoalCommand("check: npm test").kind).toBe("error");
  });

  it("reads the verbs", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "status" });
    expect(parseGoalCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("PAUSE")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("check add npm test -- --run")).toEqual({ kind: "check_add", command: "npm test -- --run" });
    expect(parseGoalCommand("check clear")).toEqual({ kind: "check_clear" });
    expect(parseGoalCommand("check add").kind).toBe("error");
  });

  it("keeps a criterion that merely starts with a verb", () => {
    expect(parseGoalCommand("clear the build warnings")).toEqual({
      kind: "set", criteria: ["clear the build warnings"], checks: [],
    });
  });

  it("drops list markers", () => {
    expect(splitGoalItems("* a\n• b\n3) c")).toEqual(["a", "b", "c"]);
  });
});

describe("/goal dispatch", () => {
  it("hands the parsed command to the caller", () => {
    const result = dispatchSlashCommand("/goal tests pass; check: npm test");
    expect(result.goalCommand).toEqual({ kind: "set", criteria: ["tests pass"], checks: ["npm test"] });
    expect(result.clearBuffer).toBe(true);
  });

  it("answers a malformed command with usage instead of acting", () => {
    const result = dispatchSlashCommand("/goal check add");
    expect(result.goalCommand).toBeUndefined();
    expect(result.systemMessage).toMatch(/usage/);
  });
});
