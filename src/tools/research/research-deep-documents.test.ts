import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { fileUrlFor } from "../files/file-cite.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { buildResearchDeepTool, RESEARCH_DEEP_TOOL, type ResearchDeepToolOptions, type ResearchModel } from "./index.js";

/** ATO-2507: research over My files, the judge pass and the time limit. */
let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "research-docs-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });
const CONTRACT = "/docs/contract.pdf";
const PASSAGES: Record<string, string> = {
  [`${CONTRACT}#2`]: "Either party may end this lease. Termination needs thirty days notice in writing.",
  "/docs/notes.md#": "Notes. The landlord asked for 60 days notice last time.",
};
const WEB: Record<string, string> = {
  "https://a.example/": "Survey results. The library employs 120 staff across the county.",
  "https://b.example/": "Annual report. The library has 80 staff on its payroll this year.",
};

interface Calls { webSearches: string[]; fileSearches: Array<Record<string, unknown>> }

function registry(over: Partial<ResearchDeepToolOptions> = {}, model: Partial<ResearchModel> = {}, folders = 1): { registry: ToolRegistry; calls: Calls } {
  const reg = new ToolRegistry();
  const calls: Calls = { webSearches: [], fileSearches: [] };
  reg.register({
    name: "os.web.search", description: "stub", readonly: true, untrustedOutput: "web search results",
    async run(args) {
      calls.webSearches.push(String(args.query));
      const results = Object.keys(WEB).map((url) => ({ url, title: url }));
      return compressToolResult({ tool: "os.web.search", status: "ok", output: "hits", details: { results } });
    },
  });
  reg.register({
    name: "os.web.fetch", description: "stub", readonly: true, untrustedOutput: "a web page",
    async run(args) {
      return compressToolResult({ tool: "os.web.fetch", status: "ok", output: WEB[String(args.url)] ?? "", details: {} });
    },
  });
  reg.register({
    name: "files.search", description: "stub", readonly: true, untrustedOutput: "indexed files",
    async run(args) {
      calls.fileSearches.push(args);
      const hits = [
        { path: CONTRACT, page: 2, snippet: "«Termination» needs thirty days", score: 2, cite: "x" },
        // A second passage of the same page is the same page to read.
        { path: CONTRACT, page: 2, snippet: "Either party", score: 1.5, cite: "x" },
        { path: "/docs/notes.md", snippet: "60 days notice", score: 1, cite: "y" },
      ];
      return compressToolResult({ tool: "files.search", status: "ok", output: "hits", details: { hits, count: hits.length } });
    },
  });
  const read: string[] = [];
  reg.register(buildResearchDeepTool({
    approvals: new ApprovalGate({ emit: () => undefined }), approvalRequired: false, tools: reg, model: {},
    now: () => new Date(2026, 10, 27, 10, 15, 0),
    documents: {
      passageText: (path, page) => { read.push(`${path}#${page ?? ""}`); return PASSAGES[`${path}#${page ?? ""}`] ?? null; },
      listFolders: () => Array.from({ length: folders }, () => ({})),
    },
    researchModel: stubModel(model),
    ...over,
  }));
  return { registry: reg, calls };
}

function stubModel(over: Partial<ResearchModel>): ResearchModel {
  return {
    plan: async () => ["Notice period"],
    findings: async (input) => {
      if (input.url.startsWith("file:")) {
        return input.url.includes("contract")
          ? [
              { claim: "Ending the lease needs thirty days notice.", quote: "Termination needs thirty days notice in writing." },
              { claim: "The lease renews by itself.", quote: "The lease renews automatically every year." },
            ]
          : [{ claim: "The landlord asked for 60 days notice.", quote: "The landlord asked for 60 days notice last time." }];
      }
      return input.url === "https://a.example/"
        ? [{ claim: "The library employs 120 staff.", quote: "The library employs 120 staff across the county." }]
        : [{ claim: "The library has 80 staff.", quote: "The library has 80 staff on its payroll this year." }];
    },
    summarise: async () => "Thirty days [1].",
    judge: async () => null,
    ...over,
  };
}

const reportOf = (details: Record<string, unknown>): string => readFileSync(String(details.reportPath), "utf8");

describe("research.deep over My files (ATO-2507)", () => {
  it("researches only the documents: no web search, quotes checked against the indexed page", async () => {
    const { registry: reg, calls } = registry();
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "What notice do my contracts need?", sources: "documents", folder: "/docs" }, ctx());
    expect(result.status).toBe("ok");
    expect(calls.webSearches).toEqual([]);
    expect(calls.fileSearches).toEqual([{ query: "Notice period", topK: 5, folder: "/docs" }]);
    expect(result.details).toMatchObject({ sources: "documents", pagesRead: 2, verified: 2, unverified: 1 });
    const report = reportOf(result.details);
    expect(report).toContain("Sources: your documents in My files, nothing searched online.");
    expect(report).toContain(`Ending the lease needs thirty days notice. ([contract.pdf, p. 2](${fileUrlFor(CONTRACT)}#page=2))`);
    // A quote the passage does not hold stays unverified.
    expect(report.slice(report.indexOf("## Unverified claims"))).toContain("The lease renews by itself.");
  });

  it("uses the documents when web search is off and no source was asked for", async () => {
    const { registry: reg, calls } = registry({ webSearchEnabled: () => false });
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "notice" }, ctx());
    expect(result.details).toMatchObject({ sources: "documents" });
    expect(calls.webSearches).toEqual([]);
  });

  it("refuses the web when web search is off, and documents when My files is empty", async () => {
    const off = registry({ webSearchEnabled: () => false }).registry;
    expect((await off.invoke(RESEARCH_DEEP_TOOL, { question: "q", sources: "web" }, ctx())).summary).toContain("web search is turned off");
    const empty = registry({}, {}, 0).registry;
    expect((await empty.invoke(RESEARCH_DEEP_TOOL, { question: "q", sources: "documents" }, ctx())).summary).toContain("No folders are in My files yet");
    // Not asked, web on: the web, even with an empty My files.
    expect((await empty.invoke(RESEARCH_DEEP_TOOL, { question: "q" }, ctx())).details).toMatchObject({ sources: "web" });
  });

  it("reads both the web and the documents with sources both", async () => {
    const { registry: reg, calls } = registry();
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "q", sources: "both" }, ctx());
    expect(calls.webSearches).toEqual(["Notice period"]);
    expect(calls.fileSearches).toHaveLength(1);
    expect(result.details).toMatchObject({ sources: "both", pagesRead: 4 });
  });

  it("refuses a folder with sources web", async () => {
    const { registry: reg } = registry();
    expect((await reg.invoke(RESEARCH_DEEP_TOOL, { question: "q", sources: "web", folder: "/docs" }, ctx())).summary).toContain("`folder` is for documents");
  });
});

describe("research.deep judge pass (ATO-2507)", () => {
  it("asks the judge about a flagged pair and prints its verdict", async () => {
    const asked: string[] = [];
    const { registry: reg } = registry({}, {
      judge: async (input) => { asked.push(`${input.a.claim} | ${input.b.claim}`); return { verdict: "different_measures", note: "One counts the county, the other the payroll." }; },
    });
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "staff", sources: "web" }, ctx());
    expect(asked).toEqual(["The library employs 120 staff. | The library has 80 staff."]);
    expect(result.details).toMatchObject({ contradictions: 1, judged: 1 });
    expect(reportOf(result.details)).toContain("Judge: they likely measure different things. One counts the county, the other the payroll.");
  });

  it("keeps the plain flag when the judge fails", async () => {
    const { registry: reg } = registry({}, { judge: async () => { throw new Error("side slot busy"); } });
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "staff", sources: "web" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ contradictions: 1, judged: 0 });
    expect(reportOf(result.details)).toContain("Not judged: the figures may measure different things");
  });
});

describe("research.deep time limit (ATO-2507)", () => {
  it("stops before the first search once maxMinutes has passed, and says so", async () => {
    let t = 0;
    const { registry: reg, calls } = registry(
      { clock: () => t },
      { plan: async () => { t += 2 * 60_000; return ["Notice period"]; } },
    );
    const result = await reg.invoke(RESEARCH_DEEP_TOOL, { question: "q", sources: "web", maxMinutes: 1 }, ctx());
    expect(result.status).toBe("ok");
    expect(calls.webSearches).toEqual([]);
    expect(result.details).toMatchObject({ stoppedEarly: true, pagesRead: 0 });
    expect(reportOf(result.details)).toContain("**Stopped early:** the 1-minute limit was reached; 0 of 1 sub-question(s) were started");
  });

  it("refuses a limit over 30 minutes", async () => {
    const { registry: reg } = registry();
    expect((await reg.invoke(RESEARCH_DEEP_TOOL, { question: "q", maxMinutes: 31 }, ctx())).summary).toContain("`maxMinutes` must be an integer 1..30");
  });
});
