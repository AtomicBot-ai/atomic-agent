/**
 * Per-question rubric builder for the LoCoMo LLM judge. The runner
 * passes one `JudgeInput { prompt, reply, rubric }` per question; the
 * rubric here is the **only** task-specific contract the judge sees
 * besides the system prompt in `build-judge-prompt.ts`.
 *
 * Design notes:
 *
 *  - Categories 1..4 are *information recall* questions — the gold
 *    answer is a short factual span (a name, date, place). The rubric
 *    instructs the judge to grade on semantic equivalence to the gold
 *    span, ignoring formatting / paraphrase / equivalent units. This
 *    is the gap a substring scorer cannot close.
 *
 *  - Category 5 (adversarial) flips the contract: the gold answer is
 *    "I don't know". A correct reply MUST decline; a confident wrong
 *    or even partially-right invented answer is the worst possible
 *    outcome and must score 1.
 *
 *  - All rubrics fit in <500 chars so the per-question judge call
 *    stays cheap on context (typical gpt-4o-mini call: ~600 input
 *    tokens including system + prompt; ~60 output tokens).
 *
 *  - The rubric is built deterministically from the question's category
 *    label and gold answer — no LLM call here. Pure function so the
 *    test suite can pin every category's wording.
 */

import type { LocomoQuestion } from "./dataset.js";

/** Default rubric template parameters tuned for the gpt-4o-mini judge. */
export interface RubricOptions {
  /** Hard cap on gold-span chars echoed back into the rubric. Default 300. */
  goldEchoMaxChars?: number;
}

/**
 * Builds the rubric string for a LoCoMo question.
 *
 * Category mapping:
 *  - 1 single_hop, 2 multi_hop, 3 temporal, 4 open_domain → recall rubric
 *  - 5 adversarial                                         → abstain rubric
 *
 * The function never inspects the agent's reply — it only knows what
 * the *expected* shape of a correct answer looks like. The judge
 * itself does the comparison against the reply.
 */
export function buildLocomoRubric(
  q: LocomoQuestion,
  opts: RubricOptions = {},
): string {
  if (q.category === 5) {
    return buildAbstentionRubric(q, opts);
  }
  return buildRecallRubric(q, opts);
}

function buildRecallRubric(q: LocomoQuestion, opts: RubricOptions): string {
  const gold = clipGold(q.answer, opts.goldEchoMaxChars ?? 300);
  const categoryHint = recallCategoryHint(q.categoryLabel);
  return [
    `Task type: information recall from a long prior conversation (${q.categoryLabel}).`,
    `Gold answer (operator-authored): ${gold}`,
    "",
    "Scoring (1..5):",
    "  5 = reply contains the gold fact OR a clearly equivalent paraphrase (same name, same date in any format, same place, same unit).",
    "  4 = reply contains the gold fact but with minor noise / extra unrelated content.",
    "  3 = reply contains a related fact from the conversation but misses the specific gold span (partial recall).",
    "  2 = reply is on-topic but contradicts the gold fact OR mixes it up with a different entity.",
    "  1 = reply hallucinates a wrong fact, refuses without reason, or is empty.",
    "",
    categoryHint,
    "Ignore differences in wording, capitalisation, date format (e.g. '7 May 2023' = 'May 7, 2023'), unit format (e.g. '2 hours' = '2 hrs'), and conversational filler.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAbstentionRubric(q: LocomoQuestion, opts: RubricOptions): string {
  const expectedAbstain = clipGold(
    q.adversarialAnswer ?? "I don't know based on the conversation.",
    opts.goldEchoMaxChars ?? 300,
  );
  return [
    "Task type: adversarial — the question CANNOT be answered from the prior conversation.",
    `Expected behaviour: the assistant must DECLINE / say it does not know / mark the fact as not in the conversation. Reference: ${expectedAbstain}`,
    "",
    "Scoring (1..5):",
    "  5 = reply explicitly declines or states the information is not in the conversation, without inventing facts.",
    "  4 = reply declines but adds speculative reasoning that does not assert a specific wrong fact.",
    "  3 = reply hedges ('I might recall...') without ultimately confirming any specific wrong fact.",
    "  2 = reply commits to a specific fact that was never in the conversation (mild hallucination).",
    "  1 = reply asserts a confident, detailed answer that was never in the conversation (full hallucination).",
    "",
    "An honest 'I don't know' is the CORRECT answer here. Confidence without grounding is the failure mode.",
  ].join("\n");
}

function recallCategoryHint(label: string): string {
  switch (label) {
    case "single_hop":
      return "Note: single-hop questions are answerable from one prior session. Expect a short, direct factual span.";
    case "multi_hop":
      return "Note: multi-hop questions require fusing facts from multiple prior sessions. Reply may stitch two short facts together; that is still correct.";
    case "temporal":
      return "Note: temporal questions test dates, durations, ordering. Accept any unambiguous equivalent date format. Ordering must match.";
    case "open_domain":
      return "Note: open-domain questions allow elaborated answers. Reply may be longer than the gold span; correctness is about the core fact.";
    default:
      return "";
  }
}

function clipGold(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Build the per-question `prompt` text shown to the judge. We give
 * the judge the LoCoMo question verbatim (no formatting noise from
 * the runner's "Answer concisely from what you remember..." wrapper)
 * so the rubric's comparison stays semantically clean.
 */
export function buildLocomoJudgePrompt(q: LocomoQuestion): string {
  return [
    "The assistant was asked the following question about a long prior conversation:",
    "",
    q.question.trim(),
  ].join("\n");
}
