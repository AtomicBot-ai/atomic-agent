/**
 * `research.deep` arguments and the run's budgets (ATO-2133, ATO-2507).
 * The model picks the breadth, the sources and the time limit within
 * hard caps; page size, findings per page and the total page count are
 * fixed here, not by the model.
 */
export interface ResearchBudgets {
  maxSubQuestions: number;
  pagesPerQuestion: number;
  /** Every page or passage read of the run, all sub-questions and sources together. */
  maxPages: number;
  /** `maxChars` asked of `os.web.fetch` for one page. */
  pageChars: number;
  /** How much of a page the reading model sees. */
  modelPageChars: number;
  findingsPerPage: number;
  /** Wall-clock limit: no new page, passage or judge call starts after it. */
  maxMs: number;
}

/**
 * Where the run looks (ATO-2507). `documents` searches the folders in
 * My files through `files.search` and never goes online; `both` reads
 * the web and the documents for every sub-question.
 */
export type ResearchSources = "web" | "documents" | "both";

const SOURCES: readonly ResearchSources[] = ["web", "documents", "both"];

export const RESEARCH_LIMITS = {
  maxSubQuestions: { default: 3, max: 5 },
  pagesPerQuestion: { default: 2, max: 3 },
  maxMinutes: { default: 10, max: 30 },
} as const;

const MAX_QUESTION_CHARS = 1_000;
/** Pages per source in one run; `both` doubles it. */
const MAX_PAGES_PER_SOURCE = 12;

export interface ResearchArgs {
  question: string;
  /** Absent: the tool picks (web when web search is on, else documents). */
  sources?: ResearchSources;
  /** For document research: one added folder (or a folder inside one). */
  folder?: string;
  budgets: ResearchBudgets;
}

export class ResearchArgsError extends Error {}

function bounded(raw: unknown, name: string, limit: { default: number; max: number }): number {
  if (raw === undefined || raw === null || raw === "") return limit.default;
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > limit.max) {
    throw new ResearchArgsError(`\`${name}\` must be an integer 1..${limit.max}`);
  }
  return value;
}

function parseSources(raw: unknown): ResearchSources | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (typeof value === "string" && (SOURCES as readonly string[]).includes(value)) return value as ResearchSources;
  throw new ResearchArgsError("`sources` must be one of: web, documents, both");
}

function parseFolder(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new ResearchArgsError("`folder` must be a path string");
  const folder = raw.trim();
  return folder.length === 0 ? undefined : folder;
}

export function parseResearchArgs(raw: Record<string, unknown>): ResearchArgs {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (question.length === 0) throw new ResearchArgsError("pass a non-empty `question`");
  if (question.length > MAX_QUESTION_CHARS) throw new ResearchArgsError(`\`question\` is longer than ${MAX_QUESTION_CHARS} characters`);
  const maxSubQuestions = bounded(raw.maxSubQuestions, "maxSubQuestions", RESEARCH_LIMITS.maxSubQuestions);
  const pagesPerQuestion = bounded(raw.pagesPerQuestion, "pagesPerQuestion", RESEARCH_LIMITS.pagesPerQuestion);
  const maxMinutes = bounded(raw.maxMinutes, "maxMinutes", RESEARCH_LIMITS.maxMinutes);
  const sources = parseSources(raw.sources);
  const folder = parseFolder(raw.folder);
  if (folder !== undefined && sources === "web") {
    throw new ResearchArgsError("`folder` is for documents; pass `sources: \"documents\"` or `\"both\"` with it");
  }
  return {
    question,
    // A folder names documents: without `sources`, it means documents.
    ...(sources !== undefined ? { sources } : folder !== undefined ? { sources: "documents" as const } : {}),
    ...(folder !== undefined ? { folder } : {}),
    budgets: {
      maxSubQuestions,
      pagesPerQuestion,
      maxPages: Math.min(MAX_PAGES_PER_SOURCE, maxSubQuestions * pagesPerQuestion),
      pageChars: 20_000,
      modelPageChars: 12_000,
      findingsPerPage: 3,
      maxMs: maxMinutes * 60_000,
    },
  };
}
