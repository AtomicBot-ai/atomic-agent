import { describe, expect, it } from "vitest";
import { checkNumbers, normalizeForQuote, numbersIn, quoteAppearsIn } from "./evidence-check.js";
import { dedupeFindings, verifyFindings } from "./verify-findings.js";
import type { Finding } from "./research-types.js";

const PAGE_A =
  "Annual report.\n\nIn 2025 the library served 1,200,000 visitors across 30 branches.\u00A0Of its 80 staff, 30 work part time.";
const PAGE_B = "Weather today: mostly sunny with a light breeze from the west. No rain expected this week.";

describe("quote verification (ATO-2133)", () => {
  it("finds a quote word for word after whitespace, quote-mark and case normalization", () => {
    expect(quoteAppearsIn("the library served 1,200,000 visitors across 30 branches", PAGE_A)).toEqual({ found: true });
    expect(quoteAppearsIn("\u201CIn 2025 the Library   served 1,200,000 visitors\u201D", PAGE_A)).toEqual({ found: true });
    expect(normalizeForQuote("It\u2019s \u2014 ok\u2026")).toBe("it's - ok...");
  });

  it("rejects a paraphrase and a fabricated quote", () => {
    expect(quoteAppearsIn("the library had 1.2 million visitors in 30 branches", PAGE_A)).toEqual({ found: false, reason: "not_on_page" });
    expect(quoteAppearsIn("visitors rose sharply across every branch last year", PAGE_A)).toEqual({ found: false, reason: "not_on_page" });
  });

  it("matches a quote cut with an ellipsis only when the pieces appear in order", () => {
    expect(quoteAppearsIn("the library served 1,200,000 visitors ... 30 work part time", PAGE_A).found).toBe(true);
    expect(quoteAppearsIn("30 work part time ... the library served 1,200,000 visitors", PAGE_A).found).toBe(false);
  });

  it("refuses quotes too short to tell from chance", () => {
    expect(quoteAppearsIn("in 2025", PAGE_A)).toEqual({ found: false, reason: "too_short" });
  });
});

describe("verifyFindings", () => {
  const finding: Finding = {
    subQuestion: 0,
    claim: "The library had 1.2 million visitors in 2025.",
    quote: "In 2025 the library served 1,200,000 visitors across 30 branches.",
    url: "https://example.org/report",
  };

  it("verifies a finding against the page it was read from", () => {
    const out = verifyFindings([finding], (url) => (url === finding.url ? PAGE_A : undefined));
    expect(out.verified).toHaveLength(1);
    expect(out.unverified).toEqual([]);
  });

  it("moves the same finding to unverified when the page text is swapped", () => {
    const out = verifyFindings([finding], () => PAGE_B);
    expect(out.verified).toEqual([]);
    expect(out.unverified).toEqual([{ ...finding, reason: "quote_not_on_page" }]);
  });

  it("leaves a finding whose page was never fetched unverified", () => {
    expect(verifyFindings([finding], () => undefined).unverified[0]?.reason).toBe("quote_not_on_page");
  });

  it("keeps one copy of a finding two sub-questions read off the same page", () => {
    const again = { ...finding, subQuestion: 1, quote: `  ${finding.quote.toUpperCase()} ` };
    expect(dedupeFindings([finding, again, { ...finding, url: "https://example.org/other" }])).toEqual([
      finding,
      { ...finding, url: "https://example.org/other" },
    ]);
  });

  it("flags a claim whose number is not in an otherwise real quote", () => {
    const out = verifyFindings([{ ...finding, claim: "The library had 1.5 million visitors." }], () => PAGE_A);
    expect(out.verified).toEqual([]);
    expect(out.unverified[0]).toMatchObject({ reason: "number_not_in_quote", unsupportedNumbers: ["1.5"] });
  });
});

describe("number check", () => {
  it("reads thousands separators, scale words and percent signs", () => {
    const [n] = numbersIn("about 1.2 million people");
    expect(n).toMatchObject({ value: 1.2, scaled: 1_200_000, unit: "million", percent: false });
    expect(numbersIn("1,200 users")[0]).toMatchObject({ value: 1200, unit: "users" });
    expect(numbersIn("grew 12.5% a year")[0]).toMatchObject({ value: 12.5, percent: true, unit: "%" });
  });

  it("accepts numbers written in the quote, also in another scale", () => {
    expect(checkNumbers("1.2 million visitors", "served 1,200,000 visitors")).toEqual({ ok: true, unsupported: [], derived: [] });
    expect(checkNumbers("30 branches", "across 30 branches")).toMatchObject({ ok: true });
  });

  it("recomputes a percentage, a sum and a difference from the quote's numbers", () => {
    const share = checkNumbers("37.5% of staff work part time", "Of its 80 staff, 30 work part time.");
    expect(share.ok).toBe(true);
    expect(share.derived).toEqual(["37.5% = 30 / 80 x 100"]);
    expect(checkNumbers("50 people in total", "20 adults and 30 children").derived).toEqual(["50 = 20 + 30"]);
    expect(checkNumbers("50 full-time staff", "Of its 80 staff, 30 work part time.").derived).toEqual(["50 = 80 - 30"]);
  });

  it("flags a number that neither appears nor follows from the quote", () => {
    expect(checkNumbers("40% work part time", "Of its 80 staff, 30 work part time.")).toEqual({
      ok: false,
      unsupported: ["40%"],
      derived: [],
    });
  });
});
