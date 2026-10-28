import { describe, expect, it } from "vitest";
import { readPromptProgress, takePromptProgress } from "./llama-prompt-progress.js";

describe("readPromptProgress", () => {
  it("reads llama.cpp's prompt_progress", () => {
    expect(
      readPromptProgress({
        content: "",
        prompt_progress: { total: 4000, cache: 1000, processed: 2500, time_ms: 1234 },
      }),
    ).toEqual({ processed: 2500, total: 4000, cached: 1000, elapsedMs: 1234 });
  });

  it("is null without progress or with a malformed one", () => {
    expect(readPromptProgress({ content: "hi" })).toBeNull();
    expect(readPromptProgress({ prompt_progress: null })).toBeNull();
    expect(readPromptProgress({ prompt_progress: { total: 0, processed: 0 } })).toBeNull();
    expect(readPromptProgress({ prompt_progress: { total: "10", processed: 1 } })).toBeNull();
  });

  it("clamps counts to the total", () => {
    expect(
      readPromptProgress({ prompt_progress: { total: 10, cache: 20, processed: 30 } }),
    ).toEqual({ processed: 10, total: 10, cached: 10, elapsedMs: 0 });
  });
});

describe("takePromptProgress", () => {
  const progress = { prompt_progress: { total: 10, cache: 0, processed: 5, time_ms: 7 } };

  it("reports and claims a progress-only event", () => {
    const seen: unknown[] = [];
    expect(takePromptProgress({ content: "", stop: false, ...progress }, (p) => seen.push(p))).toBe(true);
    expect(seen).toEqual([{ processed: 5, total: 10, cached: 0, elapsedMs: 7 }]);
  });

  it("reports but does not claim an event that also carries text or the stop", () => {
    const seen: unknown[] = [];
    expect(takePromptProgress({ content: "a", ...progress }, (p) => seen.push(p))).toBe(false);
    expect(takePromptProgress({ content: "", stop: true, ...progress }, (p) => seen.push(p))).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("claims nothing without a listener, and survives one that throws", () => {
    expect(takePromptProgress({ content: "", ...progress }, undefined)).toBe(false);
    expect(
      takePromptProgress({ content: "", ...progress }, () => {
        throw new Error("host gone");
      }),
    ).toBe(true);
  });
});
