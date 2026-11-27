import { describe, expect, it } from "vitest";
import { renderResearchReport } from "./research-report.js";
import type { ResearchResult, VerifiedFinding } from "./research-types.js";

const a: VerifiedFinding = {
  subQuestion: 0,
  claim: "37.5% of staff work part time.",
  quote: "Of its 80 staff,\n30 work part time.",
  url: "https://a.example/report",
  title: "Annual [2025] report",
  derived: ["37.5% = 30 / 80 x 100"],
};
const b: VerifiedFinding = { ...a, claim: "60% of staff work part time.", url: "https://b.example/", title: undefined, derived: [] };

const result = (over: Partial<ResearchResult> = {}): ResearchResult => ({
  question: "How many library staff work part time?",
  subQuestions: ["Staff numbers"],
  summary: "Most staff work full time [1].",
  verified: [a, b],
  unverified: [
    {
      subQuestion: 0,
      claim: "Half of the staff are volunteers.",
      quote: "volunteers help on weekends",
      url: "https://c.example/",
      reason: "quote_not_on_page",
    },
    {
      subQuestion: 0,
      claim: "The library has 95 staff.",
      quote: "Of its 80 staff, 30 work part time.",
      url: "https://a.example/report",
      title: "Annual [2025] report",
      reason: "number_not_in_quote",
      unsupportedNumbers: ["95"],
    },
  ],
  contradictions: [{ subQuestion: 0, unit: "%", a, b, values: ["37.5%", "60%"] }],
  skipped: [{ subQuestion: 0, target: "https://d.example/", reason: "HTTP 404" }],
  pagesRead: 3,
  ...over,
});

describe("renderResearchReport (ATO-2133)", () => {
  const report = renderResearchReport(result(), new Date("2026-11-27T10:15:00Z"));

  it("has the four sections in order", () => {
    const at = (h: string) => report.indexOf(`\n## ${h}\n`);
    expect(at("Summary")).toBeGreaterThan(0);
    expect(at("Summary")).toBeLessThan(at("Findings"));
    expect(at("Findings")).toBeLessThan(at("Contradictions"));
    expect(at("Contradictions")).toBeLessThan(at("Unverified claims"));
    expect(report.startsWith("# Research: How many library staff work part time?\n")).toBe(true);
    expect(report).toContain("2026-11-27 10:15 UTC. Sources: the web. 3 page(s) read, 2 verified finding(s), 2 unverified.");
    expect(report).not.toContain("Stopped early");
  });

  it("gives each finding its link and its exact quote on one blockquote line", () => {
    expect(report).toContain("1. 37.5% of staff work part time. ([Annual 2025 report](https://a.example/report))");
    expect(report).toContain("   > Of its 80 staff, 30 work part time.");
    expect(report).toContain("Computed: 37.5% = 30 / 80 x 100");
    expect(report).toContain("2. 60% of staff work part time. (<https://b.example/>)");
  });

  it("lists contradictions, unverified claims with their reason, and unread sources", () => {
    expect(report).toContain(
      "- Staff numbers: 37.5% ([Annual 2025 report](https://a.example/report)) vs 60% (<https://b.example/>). Not judged: the figures may measure different things; check both quotes.",
    );
    expect(report).toContain("- Half of the staff are volunteers. (<https://c.example/>): the quote is not on the page.");
    expect(report).toContain("- The library has 95 staff. ([Annual 2025 report](https://a.example/report)): a number in the claim is not in the quote (95).");
    expect(report).toContain("## Sources not read\n\n- https://d.example/: HTTP 404");
  });

  it("says so when nothing was verified", () => {
    const empty = renderResearchReport(
      result({ summary: "", verified: [], unverified: [], contradictions: [], skipped: [] }),
      new Date("2026-11-27T10:15:00Z"),
    );
    expect(empty).toContain("## Summary\n\nNo verified findings to summarise.");
    expect(empty).toContain("## Findings\n\nNone verified.");
    expect(empty).toContain("## Unverified claims\n\nNone.");
    expect(empty).not.toContain("## Sources not read");
  });
});

describe("renderResearchReport follow-ups (ATO-2507)", () => {
  const at = new Date("2026-11-27T10:15:00Z");

  it("prints the judge's verdict and note on a judged contradiction, with the caveat once", () => {
    const [flag] = result().contradictions;
    const judged = renderResearchReport(
      result({ contradictions: [{ ...flag!, judgement: { verdict: "different_measures", note: "One counts 2023, the other 2024." } }] }),
      at,
    );
    expect(judged).toContain("vs 60% (<https://b.example/>). Judge: they likely measure different things. One counts 2023, the other 2024.");
    expect(judged).not.toContain("Not judged");
    expect(judged).toContain("_Each judge line is the model's reading of the two quotes. It does not say which source is right._");
  });

  it("names document research as offline and counts passages", () => {
    const docs = renderResearchReport(result({ sources: "documents" }), at);
    expect(docs).toContain("Sources: your documents in My files, nothing searched online. 3 passage(s) read");
    expect(renderResearchReport(result({ sources: "both" }), at)).toContain("Sources: the web and your documents in My files.");
  });

  it("says why it stopped early", () => {
    const cut = renderResearchReport(result({ stoppedEarly: "the 10-minute limit was reached." }), at);
    expect(cut).toContain("**Stopped early:** the 10-minute limit was reached.");
    expect(cut.indexOf("Stopped early")).toBeLessThan(cut.indexOf("## Summary"));
  });
});
