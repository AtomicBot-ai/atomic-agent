/**
 * Curated English utterances for the embedding gate.
 *
 * Two buckets in one list (max cosine wins):
 *  - short referential follow-ups ("tell me more about it")
 *  - temporal / multi-hop questions that need history for recall
 *    ("when did she first mention …") — LoCoMo Temporal category
 *
 * bge/nomic embeddings are multilingual — EN exemplars still match
 * referential phrasing in other languages via cosine similarity. Per-
 * language exemplar corpora are deferred until telemetry shows a gap.
 */

export const DEFAULT_REWRITER_EXEMPLARS: readonly string[] = [
  // referential follow-ups
  "what about that one",
  "can you say more",
  "and the other thing",
  "tell me more about it",
  "the same as before",
  "continue with that",
  "what does it mean",
  "why is that",
  "how about the rest",
  "more details please",
  "and after that",
  "what else",
  // temporal / multi-hop (LoCoMo-style — long but not self-contained for recall)
  "when did that happen",
  "when did she first mention it",
  "what year was the wedding",
  "who was at the conference",
  "how long ago did they meet",
  "what happened before the trip",
  "before that what did she say",
] as const;
