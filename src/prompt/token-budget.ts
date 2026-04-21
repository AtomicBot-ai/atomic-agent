export interface TokenBudgetLimits {
  total: number;
  stablePrefix: number;
  session: number;
  worldSnapshot: number;
  conversation: number;
}

export interface BudgetCheckResult {
  ok: boolean;
  exceededBy: number;
  perSection: {
    stablePrefix: number;
    session: number;
    worldSnapshot: number;
    conversation: number;
    total: number;
  };
}

/**
 * Deterministic, non-tokenizer token estimator. We do not want to ship a
 * real tokenizer inside the sidecar just for budgeting — the estimate
 * intentionally over-counts by ~10-15% so the hard cap is safe.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  const charBased = Math.ceil(chars / 3.6);
  const wordBased = Math.ceil(words * 1.4);
  return Math.max(charBased, wordBased);
}

/**
 * Section splits (share of `total`). Only `session` is enforced by
 * `buildPrompt`; `worldSnapshot` and `conversation` are rendered in full
 * and bounded only by llama-server `n_ctx`. Their fields stay here so
 * `checkBudget` still surfaces the token counts for observability and
 * for regression tests that assert relative proportions.
 *  - stablePrefix: 35% — persona + tools + capabilities + skill catalog.
 *  - session: 15% — known facts + loaded skills (enforced here).
 *  - worldSnapshot: 15% — reference only; full ARIA snapshot is emitted.
 *  - conversation: 35% — reference only; full chat history is emitted.
 *
 * Expanding world/conversation does NOT invalidate the KV cache: both
 * sections live in the variable tail, after the stable prefix.
 */
export function defaultBudget(total: number): TokenBudgetLimits {
  return {
    total,
    stablePrefix: Math.floor(total * 0.35),
    session: Math.floor(total * 0.15),
    worldSnapshot: Math.floor(total * 0.15),
    conversation: Math.floor(total * 0.35),
  };
}

export function checkBudget(
  sections: {
    stablePrefix: string;
    session: string;
    worldSnapshot: string;
    conversation: string;
  },
  limits: TokenBudgetLimits,
): BudgetCheckResult {
  const stablePrefix = estimateTokens(sections.stablePrefix);
  const session = estimateTokens(sections.session);
  const worldSnapshot = estimateTokens(sections.worldSnapshot);
  const conversation = estimateTokens(sections.conversation);
  const total = stablePrefix + session + worldSnapshot + conversation;
  return {
    ok: total <= limits.total,
    exceededBy: Math.max(0, total - limits.total),
    perSection: {
      stablePrefix,
      session,
      worldSnapshot,
      conversation,
      total,
    },
  };
}

/**
 * Truncates a section to fit within `maxTokens` estimated tokens. We cut
 * from the tail first.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  let best = "";
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const marker = "\n… [truncated]";
  if (best.length > marker.length + 1) {
    return best.slice(0, -marker.length) + marker;
  }
  return best;
}
