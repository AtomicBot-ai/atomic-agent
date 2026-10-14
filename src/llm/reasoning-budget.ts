/**
 * The think-block budget of a local reasoning model, and its units (F49).
 *
 * A grammar-served reasoning model (`qwen-think`, `gemma4-think`) thinks
 * inside a GBNF prelude before the tool-call array. Unbounded, that
 * prelude is where a small model spends most of a step: the fusion bench
 * measured 500–7,152 reasoning tokens per tool step at 4.5 tok/s, 84–96 %
 * of every completion, one step of 22 minutes. `localModels.
 * reasoningBudgetTokens` bounds it. The grammar has no tokenizer, so the
 * bound is stated in characters at a fixed ratio; the same ratio prices
 * the reasoning a completion actually carried, so a step that hit the
 * bound reads as `reasoningTokens >= reasoningBudgetTokens` in its trace.
 *
 * The grammar bound is also capped by llama.cpp itself: a `{0,N}`
 * quantifier above 1,999 is rejected or ignored (#600), so the bound a
 * model actually gets is at most `MAX_REASONING_BUDGET_TOKENS`, whatever
 * the config asks for.
 */

import { LLAMA_SERVER_GBNF_MAX_REPETITION } from "./grammar/reasoning-prelude.js";

/** `localModels.reasoningBudgetTokens` when the file predates the field. */
export const DEFAULT_REASONING_BUDGET_TOKENS = 1500;

/**
 * Characters per budget token. Deliberately on the generous side of an
 * English tokenizer (~4.5 chars/token for prose, fewer for code), so a
 * budget cuts later, not earlier, than its name suggests.
 */
export const REASONING_CHARS_PER_TOKEN = 4;

/**
 * The largest budget llama.cpp can enforce: 1,999 grammar characters,
 * 499 tokens. A configured budget above it is clamped in the grammar.
 */
export const MAX_REASONING_BUDGET_TOKENS = Math.floor(
  LLAMA_SERVER_GBNF_MAX_REPETITION / REASONING_CHARS_PER_TOKEN,
);

/** The character bound requested for `budgetTokens`, before the llama.cpp cap; `0` stays `0` (unbounded). */
export function reasoningBudgetChars(budgetTokens: number): number {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return Math.floor(budgetTokens) * REASONING_CHARS_PER_TOKEN;
}

/**
 * The reasoning a completion carried, in budget tokens — the text before
 * the close sentinel priced at `REASONING_CHARS_PER_TOKEN`. An estimate
 * in the budget's own units, not the server's token count: that is what
 * makes a cut visible as `>= budget` whatever the tokenizer did.
 */
export function estimateReasoningTokens(reasoningText: string): number {
  if (reasoningText.length === 0) return 0;
  return Math.ceil(reasoningText.length / REASONING_CHARS_PER_TOKEN);
}

/**
 * The budget a grammar-served model really gets for `budgetTokens`, in
 * tokens: `0` (unbounded) stays `0`, anything above the llama.cpp cap
 * comes back as `MAX_REASONING_BUDGET_TOKENS`.
 */
export function effectiveReasoningBudgetTokens(budgetTokens: number): number {
  const chars = reasoningBudgetChars(budgetTokens);
  if (chars === 0) return 0;
  return Math.floor(
    Math.min(chars, LLAMA_SERVER_GBNF_MAX_REPETITION) / REASONING_CHARS_PER_TOKEN,
  );
}

/**
 * Note once, at boot, that the configured budget is above what llama.cpp
 * can enforce, so the config value is not mistaken for the real bound.
 * `info`, not `warn`: the shipped default (1,500) is above the cap too,
 * and this is a fact about the engine, not a fault in the config. Logged
 * through the runtime logger because stdout belongs to the TUI.
 */
export function logReasoningBudgetCap(
  logger: { info(message: string, context?: Record<string, unknown>): void },
  budgetTokens: number,
): void {
  const effective = effectiveReasoningBudgetTokens(budgetTokens);
  if (effective === 0 || effective >= Math.floor(budgetTokens)) return;
  logger.info("reasoning budget capped by llama.cpp grammar limit", {
    configuredTokens: Math.floor(budgetTokens),
    effectiveTokens: effective,
    grammarChars: LLAMA_SERVER_GBNF_MAX_REPETITION,
  });
}
