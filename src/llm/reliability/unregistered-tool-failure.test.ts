import { describe, expect, it } from "vitest";

import { ToolExecutionError, TransportError } from "./llm-failures.js";
import { isUnregisteredToolStreak } from "./unregistered-tool-failure.js";

describe("isUnregisteredToolStreak (ATO-1674)", () => {
  it("is the error the unknown-tool streak ends a turn with", () => {
    const streak = new ToolExecutionError("os.grep", "tool not registered in this agent: os.grep", {
      kind: "unregistered",
      nameClass: "near_miss",
    });
    expect(isUnregisteredToolStreak(streak)).toBe(true);
  });

  it("finds it under a wrapper", () => {
    const streak = new ToolExecutionError("x", "tool not registered in this agent: x", { kind: "unregistered" });
    expect(isUnregisteredToolStreak(new Error("step failed", { cause: streak }))).toBe(true);
  });

  it("is not any other tool or transport failure", () => {
    expect(isUnregisteredToolStreak(new ToolExecutionError("os.fs.read", "EACCES"))).toBe(false);
    expect(isUnregisteredToolStreak(new TransportError("offline", null, ""))).toBe(false);
    expect(isUnregisteredToolStreak(new Error("synthetic failure"))).toBe(false);
    expect(isUnregisteredToolStreak("not an error")).toBe(false);
    expect(isUnregisteredToolStreak(undefined)).toBe(false);
  });
});
