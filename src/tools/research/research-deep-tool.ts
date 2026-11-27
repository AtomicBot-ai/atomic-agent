import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { BrowserExtractModelRef } from "../browser/extract-request.js";
import { canvasSlug } from "../canvas/canvas-render.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { requireFsApproval, type FsDangerousToolOptions } from "../os/fs/fs-require-approval.js";
import type { ToolDefinition } from "../tool-registry.js";
import { findContradictions } from "./contradictions.js";
import { parseResearchArgs, ResearchArgsError, type ResearchArgs } from "./research-args.js";
import { PageCache, researchSubQuestion, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, type ToolInvoker } from "./research-gather.js";
import { createResearchModel, type ResearchModel } from "./research-model.js";
import { renderResearchReport } from "./research-report.js";
import type { Finding, ResearchResult, SkippedSource } from "./research-types.js";
import { dedupeFindings, verifyFindings } from "./verify-findings.js";

export const RESEARCH_DEEP_TOOL = "research.deep";
/** Sub-questions researched at once; each one's model calls still queue. */
const PARALLEL_SUB_QUESTIONS = 3;

export interface ResearchDeepToolOptions extends Pick<FsDangerousToolOptions, "approvals" | "approvalRequired" | "trustConfigPaths"> {
  /** The registry the web tools are registered in; calls go through its `invoke`. */
  tools: ToolInvoker;
  /** The side-call model, the same one `browser.extract` uses; bound after boot. */
  model: BrowserExtractModelRef;
  /** Test seam: the time in the file name and the report. */
  now?: () => Date;
  /** Test seam: replaces the side-call model. */
  researchModel?: ResearchModel;
}

/**
 * `research.deep` (ATO-2133): plan sub-questions, search and read pages
 * for each through `os.web.search` / `os.web.fetch` (their approvals,
 * offline mode, SSRF guard and untrusted framing apply as on any call),
 * ask the model for {claim, quote} findings per page, keep a finding only
 * when its quote is on the fetched page word for word and its numbers
 * come from the quote, flag conflicting numbers between sources, and
 * write a Markdown report as a new file in the working folder through
 * the fs approval funnel.
 */
export function buildResearchDeepTool(options: ResearchDeepToolOptions): ToolDefinition {
  const now = options.now ?? (() => new Date());
  return {
    name: RESEARCH_DEEP_TOOL,
    description:
      "Research a question on the web: plans up to 5 sub-questions, searches and reads a few pages for each, and keeps only findings whose exact quote is on the page. Writes a Markdown report (Summary, Findings with link and quote, Contradictions, Unverified claims) to a new file in the working folder and returns it.",
    readonly: false,
    untrustedOutput: "web research findings",
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: ResearchArgs;
      try {
        args = parseResearchArgs(rawArgs);
      } catch (err) {
        if (err instanceof ResearchArgsError) return errorResult(`validation: ${err.message}`);
        throw err;
      }
      for (const name of [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]) {
        if (!options.tools.has(name)) return errorResult(`${name} is not available, so there is nothing to research with`);
      }
      const side = options.model.current;
      const model = options.researchModel ?? (side ? createResearchModel(side, ctx) : undefined);
      if (model === undefined) return errorResult("the model is not ready for side calls yet; try again in a moment");
      const { question, budgets } = args;

      const planned = (await model.plan(question, budgets.maxSubQuestions, ctx.signal)).slice(0, budgets.maxSubQuestions);
      // An unreadable plan still researches the question itself.
      const subQuestions = planned.length > 0 ? planned : [question];
      const pages = new PageCache(budgets.maxPages);
      const findings: Finding[] = [];
      const skipped: SkippedSource[] = [];
      for (let start = 0; start < subQuestions.length; start += PARALLEL_SUB_QUESTIONS) {
        ctx.signal.throwIfAborted();
        const wave = subQuestions.slice(start, start + PARALLEL_SUB_QUESTIONS);
        const results = await Promise.all(wave.map((subQuestion, offset) => researchSubQuestion({
          index: start + offset, question, subQuestion, budgets, tools: options.tools, model, pages, ctx,
        })));
        for (const r of results) {
          findings.push(...r.findings);
          // A page two sub-questions share fails for both: name it once.
          for (const s of r.skipped) {
            if (!skipped.some((k) => k.target === s.target && k.reason === s.reason)) skipped.push(s);
          }
        }
      }

      const { verified, unverified } = verifyFindings(dedupeFindings(findings), pages.textOf);
      const contradictions = findContradictions(verified);
      ctx.signal.throwIfAborted();
      const summary = verified.length === 0 ? "" : await summariseOrEmpty(model, question, verified.map((f) => f.claim), ctx.signal);
      const result: ResearchResult = {
        question, subQuestions, summary, verified, unverified, contradictions, skipped, pagesRead: pages.readCount,
      };
      const at = now();
      const report = renderResearchReport(result, at);

      // A report that cannot be saved (a no, a deny rule, a write error)
      // is still returned: the research is done either way.
      const saved = await saveReport(options, ctx, question, at, report);
      return compressToolResult(
        {
          tool: RESEARCH_DEEP_TOOL,
          status: "ok",
          output: [
            "path" in saved
              ? `Saved the research report to ${saved.path}`
              : `Research report not saved: ${saved.notSaved}`,
            "path" in saved
              ? "Answer from its verified findings and give their links; say which claims stayed unverified. To send it as a file, pass this path in reply.attachments."
              : "Answer from its verified findings and give their links; say which claims stayed unverified.",
            "",
            report,
          ].join("\n"),
          details: {
            reportPath: "path" in saved ? saved.path : null,
            ...("notSaved" in saved ? { notSaved: saved.notSaved } : {}),
            question,
            subQuestions,
            pagesRead: result.pagesRead,
            verified: verified.length,
            unverified: unverified.length,
            contradictions: contradictions.length,
            skipped: skipped.length,
          },
        },
        { maxSummaryLength: 12_000, maxTailLines: Number.MAX_SAFE_INTEGER },
      );
    },
  };
}

type SaveOutcome = { path: string } | { notSaved: string };

/** Ask, then write the report as a new file; why not, when it was not saved. */
async function saveReport(
  options: ResearchDeepToolOptions,
  ctx: { workingDir: string; sessionId: string; signal: AbortSignal },
  question: string,
  at: Date,
  report: string,
): Promise<SaveOutcome> {
  let path: string;
  try {
    path = freeReportPath(ctx.workingDir, canvasSlug(question), at);
  } catch (err) {
    return { notSaved: (err as Error).message };
  }
  try {
    // Throws `ApprovalDeniedError` on a no or a saved deny rule.
    await requireFsApproval(options, {
      kind: "write",
      paths: [path],
      sessionId: ctx.sessionId,
      tool: RESEARCH_DEEP_TOOL,
      reason: "save the research report as a new file in the working folder",
      preview: path,
      workingDir: ctx.workingDir,
      ...(options.trustConfigPaths !== undefined ? { trustConfigPaths: options.trustConfigPaths } : {}),
    }, ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted || !(err instanceof ApprovalDeniedError)) throw err;
    return { notSaved: `saving was declined (${err.message})` };
  }
  try {
    await writeFile(path, report, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    return { notSaved: `could not write ${path}: ${(err as Error).message}` };
  }
  return { path };
}

/** The summary is the one model text in the report; failing it keeps the checked findings. */
async function summariseOrEmpty(model: ResearchModel, question: string, claims: string[], signal: AbortSignal): Promise<string> {
  try {
    return await model.summarise(question, claims, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return "";
  }
}

function errorResult(message: string): CompressedToolResult {
  return compressToolResult({ tool: RESEARCH_DEEP_TOOL, status: "error", output: `${RESEARCH_DEEP_TOOL}: ${message}` });
}

/** `research-<slug>-20261127-101500.md`, then `-2`, `-3`: the first name no file has. */
function freeReportPath(workingDir: string, slug: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const base = `research-${slug === "canvas" ? "report" : slug}-${stamp}`;
  for (let attempt = 1; attempt <= 50; attempt++) {
    const path = join(workingDir, `${base}${attempt === 1 ? "" : `-${attempt}`}.md`);
    if (!existsSync(path)) return path;
  }
  throw new Error(`50 reports named ${base} already exist`);
}
