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
 * Section splits driven by `total` (the `agent.tokenBudget` target for
 * the upper half of the prompt) and optional independent safety-net
 * caps for the lower half (conversation / world). Semantics per field:
 *  - `stablePrefix`, `session`: reported/enforced from `total` share.
 *  - `worldSnapshot`: safety-net cap, enforced by `buildPrompt`. Falls
 *    back to a `total * 0.15` share when the caller did not supply one
 *    (keeps existing tests stable during the transition).
 *  - `conversation`: safety-net cap, same fallback policy.
 *
 * Both `conversation` and `worldSnapshot` live in the variable tail and
 * do NOT invalidate the KV cache when they grow.
 */
export function defaultBudget(
  total: number,
  caps: { conversation?: number; worldSnapshot?: number } = {},
): TokenBudgetLimits {
  return {
    total,
    stablePrefix: Math.floor(total * 0.35),
    session: Math.floor(total * 0.15),
    worldSnapshot: caps.worldSnapshot ?? Math.floor(total * 0.15),
    conversation: caps.conversation ?? Math.floor(total * 0.35),
  };
}

/**
 * Inputs to `computeEffectiveConversationCap`. All token counts are
 * estimates from `estimateTokens`; callers measure the actual stable
 * prefix size and subtract the enforced session / world budgets.
 */
export interface EffectiveConversationCapInput {
  configuredCap: number;
  contextWindow: number | undefined;
  stablePrefixTokens: number;
  sessionTokens: number;
  worldSnapshotTokens: number;
  completionMaxTokens: number;
}

/**
 * Token headroom we keep free between the prompt and the model's
 * physical context window. Covers boundary tokens (BOS/EOS, chat-
 * template scaffolding, stop sequences) plus our token estimator's
 * over/under-count error margin.
 */
export const CONVERSATION_CAP_SAFETY_MARGIN = 512;

/**
 * Hard minimum for the effective conversation cap. Even on tiny-context
 * models we keep at least this many tokens so the last user turn and a
 * bit of recent history stay visible; `packConversation` is responsible
 * for folding the rest into a summary line when this is reached.
 */
export const CONVERSATION_CAP_FLOOR = 512;

/**
 * Resolve the actual cap enforced on the `### conversation` section for
 * a given prompt-build. When the runtime knows the model's physical
 * `contextWindow` (from `llama-server /props`), clamp the user-chosen
 * `configuredCap` to the space that remains after all fixed costs.
 * When `contextWindow` is unknown, trust the user's config as-is.
 */
export function computeEffectiveConversationCap(
  input: EffectiveConversationCapInput,
): number {
  if (!input.contextWindow || input.contextWindow <= 0) {
    return Math.max(CONVERSATION_CAP_FLOOR, input.configuredCap);
  }
  const available =
    input.contextWindow -
    input.stablePrefixTokens -
    input.sessionTokens -
    input.worldSnapshotTokens -
    input.completionMaxTokens -
    CONVERSATION_CAP_SAFETY_MARGIN;
  return Math.max(
    CONVERSATION_CAP_FLOOR,
    Math.min(input.configuredCap, available),
  );
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
