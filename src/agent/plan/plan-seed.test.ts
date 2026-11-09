import { describe, expect, it } from "vitest";

import { parsePlanSteps, seedPlanFromReply } from "./plan-seed.js";

describe("parsePlanSteps", () => {
  it("takes the numbered steps of a plan-mode reply", () => {
    const reply = [
      "Here is the plan:",
      "",
      "1. **Read** `src/date.ts` to find the parser",
      "2) Fix the timezone offset",
      "   - nested detail that is not a step",
      "3. Run the tests",
      "",
      "Say go when ready.",
    ].join("\n");
    expect(parsePlanSteps(reply)).toEqual([
      "Read src/date.ts to find the parser",
      "Fix the timezone offset",
      "Run the tests",
    ]);
  });

  it("uses bullets when there is no numbered list", () => {
    expect(parsePlanSteps("Plan:\n- one\n* two\n- [ ] three")).toEqual(["one", "two", "three"]);
  });

  it("prefers numbered steps over bullets in the same reply", () => {
    expect(parsePlanSteps("- context\n- more context\n1. do a\n2. do b")).toEqual(["do a", "do b"]);
  });

  it("skips code blocks and headings", () => {
    const reply = "## Steps\n```\n1. not a step\n2. still not\n```\n1. real one\n2. real two";
    expect(parsePlanSteps(reply)).toEqual(["real one", "real two"]);
  });

  it("does not invent a plan from prose or a single item", () => {
    expect(parsePlanSteps("I would change the parser and then run the tests.")).toEqual([]);
    expect(parsePlanSteps("1. only one step")).toEqual([]);
  });
});

describe("seedPlanFromReply", () => {
  it("seeds every step pending with the first in progress", () => {
    expect(seedPlanFromReply("1. a\n2. b\n3. c", 42)).toEqual({
      items: [
        { step: "a", status: "in_progress" },
        { step: "b", status: "pending" },
        { step: "c", status: "pending" },
      ],
      updatedAt: 42,
    });
  });

  it("seeds nothing when the reply holds no list", () => {
    expect(seedPlanFromReply("No list here.", 1)).toBeNull();
  });
});
