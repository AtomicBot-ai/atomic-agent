/**
 * `research.deep` arguments and the run's budgets (ATO-2133). The model
 * picks the breadth within hard caps; page size, findings per page and
 * the total page count are fixed here, not by the model.
 */
export interface ResearchBudgets {
  maxSubQuestions: number;
  pagesPerQuestion: number;
  /** Every page fetch of the run, all sub-questions together. */
  maxPages: number;
  /** `maxChars` asked of `os.web.fetch` for one page. */
  pageChars: number;
  /** How much of a page the reading model sees. */
  modelPageChars: number;
  findingsPerPage: number;
}

export const RESEARCH_LIMITS = {
  maxSubQuestions: { default: 3, max: 5 },
  pagesPerQuestion: { default: 2, max: 3 },
} as const;

const MAX_QUESTION_CHARS = 1_000;

export interface ResearchArgs {
  question: string;
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

export function parseResearchArgs(raw: Record<string, unknown>): ResearchArgs {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (question.length === 0) throw new ResearchArgsError("pass a non-empty `question`");
  if (question.length > MAX_QUESTION_CHARS) throw new ResearchArgsError(`\`question\` is longer than ${MAX_QUESTION_CHARS} characters`);
  const maxSubQuestions = bounded(raw.maxSubQuestions, "maxSubQuestions", RESEARCH_LIMITS.maxSubQuestions);
  const pagesPerQuestion = bounded(raw.pagesPerQuestion, "pagesPerQuestion", RESEARCH_LIMITS.pagesPerQuestion);
  return {
    question,
    budgets: {
      maxSubQuestions,
      pagesPerQuestion,
      maxPages: Math.min(12, maxSubQuestions * pagesPerQuestion),
      pageChars: 20_000,
      modelPageChars: 12_000,
      findingsPerPage: 3,
    },
  };
}
