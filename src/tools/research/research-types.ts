/** Shapes shared by the `research.deep` pipeline (ATO-2133). */

/** What a page reader returned: a claim, its exact quote and where it was read. */
export interface Finding {
  /** Index into the run's sub-questions. */
  subQuestion: number;
  claim: string;
  quote: string;
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

export interface Contradiction {
  subQuestion: number;
  /** The quantity's unit as read ("%", "users", "million"). */
  unit: string;
  a: VerifiedFinding;
  b: VerifiedFinding;
  /** The two values as written in the claims. */
  values: [string, string];
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
  subQuestions: string[];
  summary: string;
  verified: VerifiedFinding[];
  unverified: UnverifiedFinding[];
  contradictions: Contradiction[];
  skipped: SkippedSource[];
  pagesRead: number;
}
