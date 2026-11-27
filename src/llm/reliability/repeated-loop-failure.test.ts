import { describe, expect, it } from "vitest";
import { GrammarError, ModelError } from "./llm-failures.js";
import { isRepeatedModelLoop } from "./repeated-loop-failure.js";

const cut = (repeatedCut?: "loop" | "cut") =>
  new ModelError("truncated", "cut", {
    truncation: { cause: "reply_cap", completionTokens: 32_768, promptTokens: 9_000, repetitive: true },
    ...(repeatedCut !== undefined ? { repeatedCut } : {}),
  });

describe("isRepeatedModelLoop (ATO-1678)", () => {
  it("leaves out only a model that looped again after the retry named the loop", () => {
    expect(isRepeatedModelLoop(cut("loop"))).toBe(true);
    expect(isRepeatedModelLoop(new GrammarError("wrapped", "", { cause: cut("loop") }))).toBe(true);
  });

  it("keeps reporting a first loop, a repeated cut that did not loop, and other errors", () => {
    expect(isRepeatedModelLoop(cut())).toBe(false);
    expect(isRepeatedModelLoop(cut("cut"))).toBe(false);
    expect(isRepeatedModelLoop(new Error("plain"))).toBe(false);
    expect(isRepeatedModelLoop(undefined)).toBe(false);
  });
});
