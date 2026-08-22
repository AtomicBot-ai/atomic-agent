import { describe, expect, it } from "vitest";

import {
  filterSwitchRows,
  matchesSwitchFilter,
  switchFilterTerms,
} from "./composer-switch-filter.js";

const row = (label: string, detail = ""): { label: string; detail: string } => ({
  label,
  detail,
});

describe("the switch filter's matching", () => {
  it("splits on whitespace and lowercases, dropping empty terms", () => {
    expect(switchFilterTerms("  Qwen   CODER ")).toEqual(["qwen", "coder"]);
    expect(switchFilterTerms("   ")).toEqual([]);
  });

  it("is case-insensitive against the label", () => {
    expect(
      matchesSwitchFilter(row("anthropic/Claude-Opus-5"), ["opus"]),
    ).toBe(true);
  });

  it("ANDs terms so a second word narrows", () => {
    const terms = switchFilterTerms("qwen coder");
    expect(matchesSwitchFilter(row("qwen/qwen3-coder"), terms)).toBe(true);
    expect(matchesSwitchFilter(row("qwen/qwen3.7-max"), terms)).toBe(false);
  });

  it("falls back to the detail for terms the label cannot answer", () => {
    expect(
      matchesSwitchFilter(row("openrouter", "no API key"), ["api"]),
    ).toBe(true);
    expect(
      matchesSwitchFilter(row("openrouter", "no API key"), ["wizard"]),
    ).toBe(false);
  });

  it("returns the input array untouched for an empty query", () => {
    const rows = [row("a"), row("b")];
    expect(filterSwitchRows(rows, "")).toBe(rows);
    expect(filterSwitchRows(rows, "  ")).toBe(rows);
  });

  it("keeps only matching rows for a live query", () => {
    const rows = [row("cloud"), row("local"), row("custom")];
    expect(filterSwitchRows(rows, "lo").map((r) => r.label)).toEqual([
      "cloud",
      "local",
    ]);
  });
});
