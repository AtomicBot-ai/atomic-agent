import { describe, it, expect } from "vitest";
import { compressToolResult } from "./result-compressor.js";
import {
  listingResultCaps,
  MAX_LISTING_SUMMARY_CHARS,
} from "./listing-caps.js";

function listing(rows: number): string {
  const lines = ["# header"];
  for (let i = rows; i > 0; i--) lines.push(`row ${i} ${"x".repeat(40)}`);
  return lines.join("\n");
}

describe("listingResultCaps", () => {
  it("budgets one row plus a header line", () => {
    expect(listingResultCaps(20, 100).maxSummaryLength).toBe(2100);
    expect(listingResultCaps(0, 100).maxSummaryLength).toBe(100);
  });

  it("disables line-based tail truncation", () => {
    expect(listingResultCaps(20, 100).maxTailLines).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("clamps an outsized budget and floors a fractional row count", () => {
    expect(listingResultCaps(5000, 160).maxSummaryLength).toBe(
      MAX_LISTING_SUMMARY_CHARS,
    );
    expect(listingResultCaps(-3, 100).maxSummaryLength).toBe(100);
    expect(listingResultCaps(2.7, 100).maxSummaryLength).toBe(300);
  });

  it("keeps the header and the newest rows of an ordered listing", () => {
    const raw = {
      tool: "test.listing",
      status: "ok" as const,
      output: listing(50),
    };

    const withDefaults = compressToolResult(raw);
    // The default tail keeps the LAST 12 lines — the OLDEST rows —
    // and then head-slices them to 385 chars.
    expect(withDefaults.summary).not.toContain("# header");
    expect(withDefaults.summary).not.toContain("row 50 ");
    expect(withDefaults.summary.length).toBeLessThanOrEqual(400);

    const withCaps = compressToolResult(raw, listingResultCaps(50, 120));
    expect(withCaps.summary.split("\n")[0]).toBe("# header");
    expect(withCaps.summary).toContain("row 50 ");
    expect(withCaps.summary).toContain("row 1 ");
    expect(withCaps.summary).not.toContain("[truncated]");
  });
});
