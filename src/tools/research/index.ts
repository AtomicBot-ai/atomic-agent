export { buildResearchDeepTool, RESEARCH_DEEP_TOOL, type ResearchDeepToolOptions } from "./research-deep-tool.js";
export { checkNumbers, normalizeForQuote, numbersIn, quoteAppearsIn } from "./evidence-check.js";
export { verifyFindings } from "./verify-findings.js";
export { findContradictions } from "./contradictions.js";
export { judgeContradictions, MAX_JUDGED } from "./research-judge.js";
export { renderResearchReport } from "./research-report.js";
export type { ResearchSources } from "./research-args.js";
export type { ResearchDocuments } from "./research-source-choice.js";
export type { ResearchModel } from "./research-model.js";
export type {
  Contradiction,
  ContradictionJudgement,
  Finding,
  JudgeVerdict,
  ResearchResult,
  UnverifiedFinding,
  VerifiedFinding,
} from "./research-types.js";
