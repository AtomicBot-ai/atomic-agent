/**
 * memU-inspired heuristic gate for the query rewriter (Phase A).
 *
 * The detector is the cheap filter that decides whether to spend an
 * LLM call rewriting the current user message into a self-contained
 * query. Goal: skip the rewriter on long / self-contained / first-turn
 * messages and only fire on the short referential follow-ups where
 * BM25/cosine recall on the raw message would yield zero useful hits.
 *
 * Pure function — no I/O, no state. Easy to test with a matrix of
 * `(message, historyLength)` pairs.
 *
 * Gate fires (returns `true`) when **any** of:
 *  1. Message has at least one prior exchange of history (recent
 *     turns non-empty), AND
 *  2. Message length ≤ {@link SHORT_MESSAGE_WORD_THRESHOLD} words and
 *     does not contain a question word, OR
 *  3. Message contains a pronoun from the allowlist (English +
 *     Russian, lowercased word-boundary match), OR
 *  4. Message begins with a conjunction starter from the allowlist.
 *
 * Otherwise returns `false` — the caller uses the raw message as the
 * recall query (same byte path as pre-v18). The exact word lists are
 * deliberately small and conservative; tuning them up is a separate
 * decision once we have production telemetry on rewriter hit rate.
 */
export function isReferentialMessage(
  message: string,
  historyTurnCount: number,
): boolean {
  if (historyTurnCount <= 0) return false;
  const normalised = message.trim().toLowerCase();
  if (normalised.length === 0) return false;

  const words = normalised.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;

  if (wordCount <= SHORT_MESSAGE_WORD_THRESHOLD && !hasQuestionWord(words)) {
    return true;
  }
  if (hasPronoun(words)) return true;
  if (hasConjunctionStarter(words[0] ?? "")) return true;
  return false;
}

/**
 * Short-message floor for the gate. Tuned to match memU's
 * `pre_retrieval_decision` rule of thumb that messages with ≤ 5
 * meaningful words are usually anaphoric continuations of a prior
 * turn. Exposed so tests can pin the threshold.
 */
export const SHORT_MESSAGE_WORD_THRESHOLD = 5;

/**
 * Pronouns that strongly suggest a missing referent in the current
 * message — the rewriter resolves them against the prior turns.
 *
 * Kept minimal; expanding the list increases rewriter firing rate
 * (LLM cost) without obvious recall-quality wins on production
 * traces. Russian forms are included because the runtime ships
 * bilingual.
 */
const PRONOUN_ALLOWLIST: ReadonlySet<string> = new Set([
  // English
  "it",
  "that",
  "they",
  "them",
  "those",
  "this",
  "these",
  "same",
  "more",
  // Russian
  "он",
  "она",
  "оно",
  "они",
  "это",
  "то",
  "такой",
  "такая",
  "такие",
  "ещё",
]);

/**
 * Conjunctions that suggest the message is a continuation of the
 * prior assistant turn ("and what about X?", "but why does..."). When
 * the very first word matches, we treat the message as referential.
 */
const CONJUNCTION_STARTERS: ReadonlySet<string> = new Set([
  // English
  "and",
  "but",
  "also",
  // Russian
  "а",
  "и",
  "но",
  "ещё",
  "или",
]);

/**
 * Question words that DISAMBIGUATE a short message — when present we
 * assume the user is asking a concrete factual question rather than
 * referring back. Examples: "what is FTS5?" (5 words, has "what"),
 * "how does the rewriter work?" (6 words, would already fail the
 * length floor anyway). Conservative: better to skip rewriting a
 * short self-contained question than to skip it on a short pronoun
 * follow-up.
 */
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  "what",
  "when",
  "where",
  "why",
  "how",
  "who",
  "which",
  // Russian
  "что",
  "когда",
  "где",
  "почему",
  "зачем",
  "как",
  "кто",
  "какой",
  "какая",
  "какие",
]);

function hasQuestionWord(words: readonly string[]): boolean {
  for (const word of words) {
    if (QUESTION_WORDS.has(stripPunctuation(word))) return true;
  }
  return false;
}

function hasPronoun(words: readonly string[]): boolean {
  for (const word of words) {
    if (PRONOUN_ALLOWLIST.has(stripPunctuation(word))) return true;
  }
  return false;
}

function hasConjunctionStarter(first: string): boolean {
  return CONJUNCTION_STARTERS.has(stripPunctuation(first));
}

function stripPunctuation(word: string): string {
  // Strip leading/trailing common punctuation; keep internal
  // characters (e.g. "a,b" → after split, just "a" and "b"; this
  // belt-and-suspenders strips lingering `,` `.` `?` `!`).
  return word.replace(/^[.,!?;:"'`(]+|[.,!?;:"'`)]+$/g, "");
}
