import type { CompressedToolResult } from "../compressor/result-compressor.js";

/** What a host's research card shows (ATO-2507), from an ok `research.deep` result. */
export interface ResearchFrame {
  /** The saved report, or `null` when saving was declined or failed. */
  reportPath: string | null;
  question: string;
  sources: "web" | "documents" | "both";
  pagesRead: number;
  verified: number;
  unverified: number;
  contradictions: number;
  judged: number;
  skipped: number;
  stoppedEarly: boolean;
}

const SOURCES = new Set(["web", "documents", "both"]);
const QUESTION_MAX = 300;

/**
 * `research` on a `tool_result` frame (ATO-2507): the counts and the
 * report path of an ok `research.deep` call, for the desktop's report
 * card. The frame is the only live path: the summary is clipped and the
 * session store keeps no `details`. Left out for every other call and
 * for a shape a host could not trust (a count that is not a whole
 * non-negative number, a path that is not a string).
 */
export function researchFrame(result: CompressedToolResult): { research?: ResearchFrame } {
  if (result.tool !== "research.deep" || result.status !== "ok") return {};
  const d = result.details ?? {};
  const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  const reportPath = d.reportPath === null ? null : typeof d.reportPath === "string" && d.reportPath.length > 0 ? d.reportPath : undefined;
  if (reportPath === undefined || typeof d.question !== "string") return {};
  const numbers = [d.pagesRead, d.verified, d.unverified, d.contradictions, d.skipped];
  if (!numbers.every(count)) return {};
  return {
    research: {
      reportPath,
      question: d.question.length > QUESTION_MAX ? `${d.question.slice(0, QUESTION_MAX - 3)}...` : d.question,
      sources: typeof d.sources === "string" && SOURCES.has(d.sources) ? (d.sources as ResearchFrame["sources"]) : "web",
      pagesRead: d.pagesRead as number,
      verified: d.verified as number,
      unverified: d.unverified as number,
      contradictions: d.contradictions as number,
      judged: count(d.judged) ? d.judged : 0,
      skipped: d.skipped as number,
      stoppedEarly: d.stoppedEarly === true,
    },
  };
}
