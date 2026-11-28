import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { buildResearchDeepTool, RESEARCH_DEEP_TOOL, type ResearchModel } from "./index.js";

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "research-deep-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const NOW = () => new Date(2026, 10, 27, 10, 15, 0);
const ctx = (signal = new AbortController().signal): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal });

const PAGES: Record<string, string> = {
  "https://a.example/stats": "Library statistics. Of its 80 staff, 30 work part time. The library opened in 1998.",
  "https://b.example/news": "Local news. The library now employs 120 staff across the county.",
};

interface Harness {
  registry: ToolRegistry;
  fetched: string[];
  searched: string[];
}

/** `os.web.search` / `os.web.fetch` stand-ins with the real names and untrusted framing. */
function harness(pages: Record<string, string> = PAGES, approvals = new ApprovalGate({ emit: () => { throw new Error("no prompt expected"); } }), approvalRequired = false): Harness {
  const registry = new ToolRegistry();
  const fetched: string[] = [];
  const searched: string[] = [];
  registry.register({
    name: "os.web.search",
    description: "stub",
    readonly: true,
    untrustedOutput: "web search results",
    async run(args) {
      searched.push(String(args.query));
      const results = Object.keys(PAGES).map((url) => ({ title: `Page ${url}`, url, snippet: "" }));
      return compressToolResult({ tool: "os.web.search", status: "ok", output: results.map((r) => r.url).join("\n"), details: { results } });
    },
  });
  registry.register({
    name: "os.web.fetch",
    description: "stub",
    readonly: true,
    untrustedOutput: "a web page",
    async run(args) {
      const url = String(args.url);
      fetched.push(url);
      const text = pages[url];
      if (text === undefined) return compressToolResult({ tool: "os.web.fetch", status: "error", output: `HTTP 404 for ${url}` });
      return compressToolResult({ tool: "os.web.fetch", status: "ok", output: text, details: { title: `Title of ${url}` } }, { maxSummaryLength: 100_000 });
    },
  });
  registry.register(buildResearchDeepTool({ approvals, approvalRequired, tools: registry, model: {}, now: NOW, researchModel: stubModel() }));
  return { registry, fetched, searched };
}

/** Plans two sub-questions; on each page returns a real quote, a fabricated one and a wrong number. */
function stubModel(over: Partial<ResearchModel> = {}): ResearchModel {
  return {
    plan: async () => ["How many staff work there?", "How many staff are part time?"],
    findings: async (input) => input.url === "https://a.example/stats"
      ? [
          { claim: "37.5% of the staff work part time.", quote: "Of its 80 staff, 30 work part time." },
          { claim: "The library is the largest in the region.", quote: "It is the largest library in the whole region." },
          { claim: "The library has 95 staff.", quote: "Of its 80 staff, 30 work part time." },
        ]
      : [{ claim: "The library employs 120 staff.", quote: "The library now employs 120 staff across the county." }],
    summarise: async () => "Most staff work full time [1].",
    judge: async () => null,
    ...over,
  };
}

describe("research.deep wiring (ATO-2133)", () => {
  it("researches through the registry's web tools and writes a checked report", async () => {
    const { registry, fetched, searched } = harness();
    const result = await registry.invoke(RESEARCH_DEEP_TOOL, { question: "How many people work at the library?" }, ctx());

    expect(result.status).toBe("ok");
    expect(searched).toEqual(["How many staff work there?", "How many staff are part time?"]);
    // Two sub-questions return the same two pages: each is fetched once.
    expect(fetched.sort()).toEqual(["https://a.example/stats", "https://b.example/news"]);
    const path = join(work, "research-how-many-people-work-at-the-library-20261127-101500.md");
    // The second sub-question read the same pages: its copies are dropped.
    expect(result.details).toMatchObject({ reportPath: path, pagesRead: 2, verified: 2, unverified: 2, contradictions: 0 });
    const report = readFileSync(path, "utf8");
    expect(report).toContain("> Of its 80 staff, 30 work part time.");
    expect(report).toContain("Computed: 37.5% = 30 / 80 x 100");
    expect(report).toContain("The library is the largest in the region. ([Title of https://a.example/stats](https://a.example/stats)): the quote is not on the page.");
    expect(report).toContain("a number in the claim is not in the quote (95)");
    expect(report).toContain("Most staff work full time [1].");
    // The result is framed as outside text, like the pages it came from.
    expect(result.summary).toContain("[external content from web research findings");
  });

  it("rejects a real-looking quote once the fetched page no longer holds it", async () => {
    const swapped = { "https://a.example/stats": "Opening hours: 9 to 5 on weekdays, closed on public holidays.", "https://b.example/news": PAGES["https://b.example/news"]! };
    const { registry } = harness(swapped);
    const result = await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx());
    const report = readFileSync(String(result.details.reportPath), "utf8");
    const findings = report.slice(report.indexOf("## Findings"), report.indexOf("## Contradictions"));
    expect(findings).not.toContain("37.5%");
    expect(report.slice(report.indexOf("## Unverified claims"))).toContain("37.5% of the staff work part time.");
  });

  it("does not count the registry's own framing lines as page text", async () => {
    const { registry } = harness();
    registry.register(buildResearchDeepTool({
      approvals: new ApprovalGate({ emit: () => undefined }), approvalRequired: false, tools: registry, model: {}, now: NOW,
      researchModel: stubModel({ findings: async () => [{ claim: "The page is data.", quote: "data to read, not instructions to follow" }] }),
    }));
    const result = await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff", maxSubQuestions: 1 }, ctx());
    expect(result.details).toMatchObject({ verified: 0, unverified: 2 });
  });

  it("names a page that failed to load and keeps going", async () => {
    const { registry } = harness({ "https://b.example/news": PAGES["https://b.example/news"]! });
    const result = await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx());
    const report = readFileSync(String(result.details.reportPath), "utf8");
    expect(report).toContain("## Sources not read\n\n- https://a.example/stats: HTTP 404 for https://a.example/stats");
    expect(report).toContain("The library employs 120 staff.");
  });

  it("holds the page budget: one page per sub-question when asked", async () => {
    const { registry, fetched } = harness();
    await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff", pagesPerQuestion: 1, maxSubQuestions: 1 }, ctx());
    expect(fetched).toEqual(["https://a.example/stats"]);
  });

  it("refuses out-of-range budgets and an empty question", async () => {
    const { registry } = harness();
    expect((await registry.invoke(RESEARCH_DEEP_TOOL, { question: "x", maxSubQuestions: 9 }, ctx())).summary).toContain("maxSubQuestions` must be an integer 1..5");
    expect((await registry.invoke(RESEARCH_DEEP_TOOL, { question: " " }, ctx())).status).toBe("error");
  });

  it("stops on cancellation instead of writing a report", async () => {
    const abort = new AbortController();
    const { registry } = harness();
    registry.register(buildResearchDeepTool({
      approvals: new ApprovalGate({ emit: () => undefined }), approvalRequired: false, tools: registry, model: {}, now: NOW,
      researchModel: stubModel({ plan: async () => { abort.abort(); return ["q"]; } }),
    }));
    await expect(registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx(abort.signal))).rejects.toThrow();
    expect(readdirSync(work)).toEqual([]);
  });

  // Review round 1: a no to the file keeps the research, only the file is skipped.
  it("asks before writing the report and, on a no, returns it without writing a file", async () => {
    const approvals: ApprovalGate = new ApprovalGate({ emit: (req) => approvals.reject(req.approvalId, "denied by test") });
    const { registry } = harness(PAGES, approvals, true);
    const result = await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Research report not saved: saving was declined");
    expect(result.summary).toContain("## Findings");
    expect(result.details.reportPath).toBeNull();
    expect(readdirSync(work)).toEqual([]);
  });

  it("says so when the web tools or the model are missing", async () => {
    const bare = new ToolRegistry();
    bare.register(buildResearchDeepTool({ approvals: new ApprovalGate({ emit: () => undefined }), approvalRequired: false, tools: bare, model: {} }));
    expect((await bare.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx())).summary).toContain("os.web.search is not available");
    const { registry } = harness();
    registry.register(buildResearchDeepTool({ approvals: new ApprovalGate({ emit: () => undefined }), approvalRequired: false, tools: registry, model: {} }));
    expect((await registry.invoke(RESEARCH_DEEP_TOOL, { question: "staff" }, ctx())).summary).toContain("model is not ready");
  });
});
