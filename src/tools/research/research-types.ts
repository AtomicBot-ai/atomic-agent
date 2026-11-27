import type { ResearchSources } from "./research-args.js";

/** Shapes shared by the `research.deep` pipeline (ATO-2133, ATO-2507). */

/** What a page reader returned: a claim, its exact quote and where it was read. */
export interface Finding {
  /** Index into the run's sub-questions. */
  subQuestion: number;
  claim: string;
  quote: string;
  /**
   * Where it was read: the web page's URL, or for a document the
   * `file://` URL `files.search` cites (`#page=N` on a PDF page), so the
   * report's link opens the same page a `files.search` citation does.
   */
  url: string;
  title?: string;
}

export type UnverifiedReason =
  /** The quote is not on the fetched page, even after normalization. */
  | "quote_not_on_page"
  /** The quote is too short to tell a match from chance. */
  | "quote_too_short"
  /** The quote is on the page, but a number in the claim is not in it. */
  | "number_not_in_quote";

export interface VerifiedFinding extends Finding {
  /** Claim numbers recomputed from quote numbers ("37.5% = 30 / 80 x 100"). */
  derived: string[];
}

export interface UnverifiedFinding extends Finding {
  reason: UnverifiedReason;
  /** For `number_not_in_quote`: the numbers, as the claim wrote them. */
  unsupportedNumbers?: string[];
}

/**
 * The model judge's reading of one flagged pair (ATO-2507): `conflict`
 * when both quotes give the same measure different values,
 * `different_measures` when they count different things (another year,
 * place, group or definition), `unclear` when the quotes do not say.
 */
export type JudgeVerdict = "conflict" | "different_measures" | "unclear";

export interface ContradictionJudgement {
  verdict: JudgeVerdict;
  /** One plain sentence on why, from the two quotes. */
  note: string;
}

export interface Contradiction {
  subQuestion: number;
  /** The quantity's unit as read ("%", "users", "million"). */
  unit: string;
  a: VerifiedFinding;
  b: VerifiedFinding;
  /** The two values as written in the claims. */
  values: [string, string];
  /** The judge pass's verdict; absent when it was not judged (a failed call, over the cap, out of time). */
  judgement?: ContradictionJudgement;
}

/** A page that could not be used, and why, for the report's notes. */
export interface SkippedSource {
  subQuestion: number;
  /** The URL, or the search query when the search itself failed. */
  target: string;
  reason: string;
}

export interface ResearchResult {
  question: string;
  /** Where the run looked; absent reads as the web. */
  sources?: ResearchSources;
  subQuestions: string[];
  summary: string;
  verified: VerifiedFinding[];
  unverified: UnverifiedFinding[];
  contradictions: Contradiction[];
  skipped: SkippedSource[];
  pagesRead: number;
  /** Why the run stopped before it read everything it planned, in plain words. */
  stoppedEarly?: string;
}
