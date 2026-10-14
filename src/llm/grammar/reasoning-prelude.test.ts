import { describe, expect, it } from "vitest";

import {
  buildReasoningPreludeRules,
  withUnboundedReasoningPrelude,
} from "./reasoning-prelude.js";

describe("buildReasoningPreludeRules budget clamp (llama.cpp GBNF MAX_REPETITION_THRESHOLD = 2000, safe ceiling 1,999, #600)", () => {
  const SENTINEL = "</think";

  it("clamps budgets above llama.cpp's safe GBNF ceiling to 1,999", () => {
    // Default production budget: 1,500 tokens × 4 = 6,000 chars → clamped.
    const rules = buildReasoningPreludeRules(
      "think",
      SENTINEL,
      undefined,
      6000,
    );
    expect(rules).toContain("think-body ::= think-char{0,1999}");
  });

  it("clamps exactly 2,000, the value older llama-server builds reject", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 2000);
    expect(rules).toContain("think-body ::= think-char{0,1999}");
  });

  it("leaves budgets at or below the limit unchanged", () => {
    // 1,999 is the boundary — not clamped. 2,000 is not safe: older
    // llama-server builds reject exactly MAX_REPETITION_THRESHOLD.
    const atBoundary = buildReasoningPreludeRules(
      "think",
      SENTINEL,
      undefined,
      1999,
    );
    expect(atBoundary).toContain("think-char{0,1999}");

    // A small budget stays as-is.
    const small = buildReasoningPreludeRules("think", SENTINEL, undefined, 8);
    expect(small).toContain("think-char{0,8}");
  });

  it("keeps the unbounded form when the budget is 0", () => {
    const unbounded = buildReasoningPreludeRules(
      "think",
      SENTINEL,
      undefined,
      0,
    );
    expect(unbounded).toContain("think-body ::= think-fragment*");
    expect(unbounded).not.toMatch(/think-char\{0,\d+\}/);
  });

  it("the clamped grammar still lifts correctly via withUnboundedReasoningPrelude", () => {
    const clamped = buildReasoningPreludeRules("think", SENTINEL, undefined, 6000);
    const lifted = withUnboundedReasoningPrelude(clamped);
    expect(lifted).toContain("think-body ::= think-char*");
    expect(lifted).not.toContain("think-char{0,1999}");
  });
});
