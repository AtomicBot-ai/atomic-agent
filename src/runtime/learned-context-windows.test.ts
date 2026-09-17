import { describe, expect, it } from "vitest";
import { LearnedContextWindows } from "./learned-context-windows.js";

describe("LearnedContextWindows", () => {
  it("keeps the smallest observation per key", () => {
    const windows = new LearnedContextWindows();
    windows.observe("openrouter/m", 32_768);
    windows.observe("openrouter/m", 16_384);
    windows.observe("openrouter/m", 24_000);
    expect(windows.get("openrouter/m")).toBe(16_384);
    expect(windows.get("other/m")).toBeUndefined();
  });

  it("grows to what the server held instead of forgetting", () => {
    // The old reset dropped the observation here and the next prompt
    // was packed to the nominal 128k again.
    const windows = new LearnedContextWindows();
    windows.observe("k", 16_384);
    windows.raise("k", 20_500);
    expect(windows.get("k")).toBe(20_500);
    windows.raise("k", 18_000);
    expect(windows.get("k")).toBe(20_500);
  });

  it("only raises a window it has learned, and ignores nonsense", () => {
    const windows = new LearnedContextWindows();
    windows.raise("k", 20_500);
    expect(windows.get("k")).toBeUndefined();
    windows.observe("k", Number.NaN);
    windows.observe("k", 0);
    expect(windows.get("k")).toBeUndefined();
  });
});
