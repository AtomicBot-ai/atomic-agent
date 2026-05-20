/**
 * memU-inspired retrieval pipeline additions (Phase A).
 *
 * Currently ships one feature: a heuristic-gated query rewriter that
 * wraps the default memory context provider as a decorator. Opt-in
 * via `memory.retrieve.rewriter.enabled` (default `false`).
 *
 * Module layout follows the rest of `src/memory/*`:
 *  - `referential-detector` — pure heuristic gate.
 *  - `query-rewriter-prompt` — prompt builder + stable prefix.
 *  - `query-rewriter-grammar` — GBNF envelope.
 *  - `query-rewriter-parser` — completion parser, fire-safe.
 *  - `query-rewriter-runner` — orchestrates the call; folds every
 *    failure mode into "use the raw message". Always pins
 *    `slotId = -1` so the main agent slot and the reflection slot
 *    are untouched.
 *  - `rewriter-aware-recall-provider` — decorator over
 *    `MemoryContextProvider`. Pulls history from
 *    `input.recentTurns` populated by the agent loop.
 */

export {
  isReferentialMessage,
  SHORT_MESSAGE_WORD_THRESHOLD,
} from "./referential-detector.js";
export {
  QUERY_REWRITER_GRAMMAR,
} from "./query-rewriter-grammar.js";
export {
  QUERY_REWRITER_STABLE_PREFIX,
  REWRITER_LINE_CHAR_CAP,
  REWRITER_CURRENT_CHAR_CAP,
  buildRewriterPrompt,
  type RewriterHistoryTurn,
  type RewriterPromptInput,
} from "./query-rewriter-prompt.js";
export {
  REWRITTEN_QUERY_MAX_LENGTH,
  parseRewriterOutput,
} from "./query-rewriter-parser.js";
export {
  REWRITER_SLOT_ID,
  createQueryRewriterRunner,
  type QueryRewriterRunner,
  type QueryRewriterRunnerDeps,
  type RewriterLlmComplete,
  type RewriterOutcome,
} from "./query-rewriter-runner.js";
export {
  createRewriterAwareMemoryContextProvider,
  type RewriterAwareProviderOptions,
} from "./rewriter-aware-recall-provider.js";
