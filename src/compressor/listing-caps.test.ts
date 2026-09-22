import { describe, it, expect } from "vitest";
import { compressToolResult } from "./result-compressor.js";
import {
  listingResultCaps,
  MAX_LISTING_SUMMARY_CHARS,
  MIN_LISTING_SUMMARY_CHARS,
} from "./listing-caps.js";

function listing(rows: number): string {
  const lines = ["# header"];
  for (let i = rows; i > 0; i--) lines.push(`row ${i} ${"x".repeat(40)}`);
  return lines.join("\n");
}

describe("listingResultCaps", () => {
  it("budgets one row plus a header line", () => {
    expect(listingResultCaps(20, 100).maxSummaryLength).toBe(2100);
    expect(listingResultCaps(0, 500).maxSummaryLength).toBe(500);
  });

  it("disables line-based tail truncation", () => {
    expect(listingResultCaps(20, 100).maxTailLines).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("clamps an outsized budget and floors a fractional row count", () => {
    // Pinned to the literal, not to the constant: the ceiling is the
    // whole prompt-budget argument (a fresh listing is what
    // `packConversation` prices, and the cut it forces is held), so a
    // silent change back to 8 000 has to fail here.
    expect(MAX_LISTING_SUMMARY_CHARS).toBe(4_000);
    expect(listingResultCaps(5000, 160).maxSummaryLength).toBe(
      MAX_LISTING_SUMMARY_CHARS,
    );
    expect(listingResultCaps(-3, 500).maxSummaryLength).toBe(500);
    expect(listingResultCaps(2.7, 500).maxSummaryLength).toBe(1500);
  });

  // A row-derived budget for a one-row listing can land under the
  // compressor's own 400-char default, which would make a small
  // listing WORSE than it was before these caps existed.
  it("never budgets less than the compressor's own default", () => {
    expect(MIN_LISTING_SUMMARY_CHARS).toBe(400);
    expect(listingResultCaps(1, 160).maxSummaryLength).toBe(400);
    expect(listingResultCaps(0, 280).maxSummaryLength).toBe(400);
    expect(listingResultCaps(0, 100).maxSummaryLength).toBe(400);
  });

  // A NaN cap makes `joined.length > cap` false, which would store the
  // summary uncapped — the opposite of what this module promises.
  it("falls back to the floor rather than producing a NaN cap", () => {
    for (const caps of [
      listingResultCaps(Number.NaN, 160),
      listingResultCaps(20, Number.NaN),
      listingResultCaps(Number.POSITIVE_INFINITY, 160),
      listingResultCaps(20, Number.POSITIVE_INFINITY),
    ]) {
      expect(caps.maxSummaryLength).toBe(MIN_LISTING_SUMMARY_CHARS);
    }
    expect(listingResultCaps(20, 0).maxSummaryLength).toBe(
      MIN_LISTING_SUMMARY_CHARS,
    );
    expect(listingResultCaps(20, -5).maxSummaryLength).toBe(
      MIN_LISTING_SUMMARY_CHARS,
    );
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

  // The two cases the floor exists for, end to end through the real
  // compressor, with the shapes that produced them: one matched
  // process whose command is a long executable path, and a clean
  // `os.git.status` whose only content is its header.
  it("is never worse than the compressor default on a small listing", () => {
    const longRow = `38065    1        someone              0.0   0.0 ${"/a-long-path-segment".repeat(12)}/thing`;
    const oneRow = {
      tool: "os.proc.list",
      status: "ok" as const,
      output: `PID      PPID     USER               CPU%   MEM%   COMMAND\n${longRow}`,
    };
    expect(oneRow.output.length).toBeGreaterThan(320);
    const defaults = compressToolResult(oneRow);
    const capped = compressToolResult(oneRow, listingResultCaps(1, 160));
    expect(capped.summary.length).toBeGreaterThanOrEqual(
      defaults.summary.length,
    );
    expect(capped.summary).toContain(longRow);
    expect(capped.summary).not.toContain("[truncated]");

    const headerOnly = {
      tool: "os.git.status",
      status: "ok" as const,
      output: `# branch: ${"x".repeat(140)} (${"x".repeat(140)})\n(working tree clean)`,
    };
    const cleanCapped = compressToolResult(
      headerOnly,
      listingResultCaps(0, 280),
    );
    expect(cleanCapped.summary.endsWith("(working tree clean)")).toBe(true);
    expect(cleanCapped.summary).not.toContain("[truncated]");
  });
});
