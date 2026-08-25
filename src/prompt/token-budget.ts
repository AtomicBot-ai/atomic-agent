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
    loadedSkills: number;
    sessionFacts: number;
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
  /**
   * Tokens consumed by the `### profile` section. Optional — absent on
   * legacy callers that build the prompt without the memory fabric. The
   * cap clamp subtracts it just like session/world to keep the final
   * conversation room accurate.
   */
  profileTokens?: number;
  /**
   * Tokens consumed by the `### recalled` section. Optional — the hybrid
   * memory pipeline (PR-B) only populates it when the agent loop
   * pre-fetches notes; legacy callers pass nothing and the clamp treats
   * it as `0`.
   */
  recalledTokens?: number;
  /** Tokens consumed by the `### memory-index` section. Same contract as `recalledTokens`. */
  memoryIndexTokens?: number;
  /**
   * Memory-v2 phase 5. Tokens consumed by the `### lessons` pointer
   * section. Subtracted from the effective conversation cap the
   * same way `profileTokens` is. Omit when phase 5 is disabled.
   */
  lessonsTokens?: number;
  /**
   * Memory-v2 phase 7b. Tokens consumed by the `### procedures`
   * pointer section. Subtracted from the effective conversation cap
   * just like `lessonsTokens`. Omit when phase 7b is disabled.
   */
  proceduresTokens?: number;
  /**
   * Tokens consumed by the `### loaded-tools` section (rare tool schemas).
   */
  loadedToolsTokens?: number;
  completionMaxTokens: number;
  /**
   * `agent.conversationMaxTokens` was left at {@link CONVERSATION_CAP_AUTO}:
   * the transcript takes whatever the window leaves rather than being
   * held under a fixed ceiling. `configuredCap` is then only the
   * fallback for an unknown window — see
   * {@link computeEffectiveConversationCap}.
   */
  autoFill?: boolean;
}

/**
 * Token headroom we keep free between the prompt and the model's
 * physical context window. Covers boundary tokens (BOS/EOS, chat-
 * template scaffolding, stop sequences) plus our token estimator's
 * over/under-count error margin.
 */
export const CONVERSATION_CAP_SAFETY_MARGIN = 512;

/**
 * Approximate token cost of the agent's fixed prompt scaffolding — the
 * stable prefix (persona + tool catalog + capabilities + instructions),
 * measured at ~5.2k and rounded up for drift. Only used for the startup
 * sanity check on a model's context window; nothing depends on it being
 * exact, and the real per-build figure comes from `checkBudget`.
 */
export const AGENT_FIXED_PROMPT_TOKENS = 6000;

/**
 * Smallest context window in which the agent can actually complete a
 * step: fixed scaffolding + a full generation budget + boundary margin.
 * `contextWindow` below this means every step will hit llama.cpp's
 * context ceiling and come back `truncated`.
 */
export function minUsableContextWindow(completionMaxTokens: number): number {
  return (
    AGENT_FIXED_PROMPT_TOKENS +
    completionMaxTokens +
    CONVERSATION_CAP_SAFETY_MARGIN
  );
}

/**
 * Hard minimum for the effective conversation cap. Even on tiny-context
 * models we keep at least this many tokens so the last user turn and a
 * bit of recent history stay visible; `packConversation` is responsible
 * for folding the rest into a summary line when this is reached.
 */
export const CONVERSATION_CAP_FLOOR = 512;

/**
 * `agent.conversationMaxTokens: 0` — let the window decide.
 *
 * The same sentinel `localModels.managed.contextSize` already uses for
 * the same idea, and for the same reason: the useful value is a function
 * of hardware the config file cannot see, so the only honest fixed
 * number is "don't fix it".
 *
 * The knob it replaces was a *ceiling*, and a ceiling that never rises
 * is indistinguishable from a bug once the window grows past it. An
 * operator who starts `llama-server` with `-c 48000` has said what they
 * want the agent to have; a 32k cap sitting above that window quietly
 * declines two thirds of the difference, and the only visible trace is a
 * number in the composer that looks like it *is* the window.
 */
export const CONVERSATION_CAP_AUTO = 0;

/**
 * Resolve the actual cap enforced on the `### conversation` section for
 * a given prompt-build. When the runtime knows the model's physical
 * `contextWindow` (from `llama-server /props`), clamp the user-chosen
 * `configuredCap` to the space that remains after all fixed costs.
 * When `contextWindow` is unknown, trust the user's config as-is.
 *
 * Under `autoFill` there is no configured ceiling at all: whatever the
 * window leaves over is the cap. `configuredCap` is still read in that
 * mode, but only as the fallback for a window nobody knows — a cloud
 * model with no published context length gives the maths nothing to
 * subtract from, and an unbounded transcript there would be a promise
 * about someone else's server that this process cannot keep.
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
    (input.profileTokens ?? 0) -
    (input.recalledTokens ?? 0) -
    (input.memoryIndexTokens ?? 0) -
    (input.lessonsTokens ?? 0) -
    (input.proceduresTokens ?? 0) -
    (input.loadedToolsTokens ?? 0) -
    input.completionMaxTokens -
    CONVERSATION_CAP_SAFETY_MARGIN;
  if (input.autoFill) return Math.max(CONVERSATION_CAP_FLOOR, available);
  return Math.max(
    CONVERSATION_CAP_FLOOR,
    Math.min(input.configuredCap, available),
  );
}

export function checkBudget(
  sections: {
    stablePrefix: string;
    loadedSkills: string;
    sessionFacts: string;
    worldSnapshot: string;
    conversation: string;
  },
  limits: TokenBudgetLimits,
): BudgetCheckResult {
  const stablePrefix = estimateTokens(sections.stablePrefix);
  const loadedSkills = estimateTokens(sections.loadedSkills);
  const sessionFacts = estimateTokens(sections.sessionFacts);
  const worldSnapshot = estimateTokens(sections.worldSnapshot);
  const conversation = estimateTokens(sections.conversation);
  const sessionForLimit = loadedSkills + sessionFacts;
  const total = stablePrefix + sessionForLimit + worldSnapshot + conversation;
  return {
    ok: total <= limits.total,
    exceededBy: Math.max(0, total - limits.total),
    perSection: {
      stablePrefix,
      loadedSkills,
      sessionFacts,
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
