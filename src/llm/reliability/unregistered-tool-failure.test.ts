import { describe, expect, it } from "vitest";

import { ToolExecutionError, TransportError } from "./llm-failures.js";
import { isUnregisteredToolStreak } from "./unregistered-tool-failure.js";

const streak = (nameClass?: "near_miss" | "mcp_like" | "other") =>
  new ToolExecutionError("os.grep", "tool not registered in this agent: os.grep", {
    kind: "unregistered",
    ...(nameClass !== undefined ? { nameClass } : {}),
  });

describe("isUnregisteredToolStreak (ATO-1674)", () => {
  it("is the near-miss streak the unknown-tool limit ends a turn with", () => {
    expect(isUnregisteredToolStreak(streak("near_miss"))).toBe(true);
  });

  it("finds it under a wrapper", () => {
    expect(isUnregisteredToolStreak(new Error("step failed", { cause: streak("near_miss") }))).toBe(true);
  });

  it("is not a streak on a name that is close to no tool", () => {
    // May be a tool the prompt showed and the registry lacks: ours to fix.
    expect(isUnregisteredToolStreak(streak("other"))).toBe(false);
    expect(isUnregisteredToolStreak(streak("mcp_like"))).toBe(false);
    expect(isUnregisteredToolStreak(streak())).toBe(false);
  });

  it("is not any other tool or transport failure", () => {
    expect(isUnregisteredToolStreak(new ToolExecutionError("os.fs.read", "EACCES"))).toBe(false);
    expect(isUnregisteredToolStreak(new ToolExecutionError("os.fs.read", "x", { nameClass: "near_miss" }))).toBe(false);
    expect(isUnregisteredToolStreak(new TransportError("offline", null, ""))).toBe(false);
    expect(isUnregisteredToolStreak(new Error("synthetic failure"))).toBe(false);
    expect(isUnregisteredToolStreak("not an error")).toBe(false);
    expect(isUnregisteredToolStreak(undefined)).toBe(false);
  });
});
