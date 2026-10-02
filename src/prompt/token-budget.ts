export interface TokenBudgetLimits {
  total: number;
  /**
   * Derived figure only: nothing trims the stable prefix and nothing
   * reports this number, and the only read of it in the tree is the
   * assertion in `token-budget.test.ts` that pins the share. Left in
   * place because `TokenBudgetLimits` is re-exported from
   * `src/prompt/index.ts` — dropping the field is an API break, not a
   * cleanup. See {@link defaultBudget}.
   */
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
  return estimateTokensFromCounts(text.length, text.trim().split(/\s+/).length);
}

/**
 * The formula behind {@link estimateTokens}, over counts a caller has
 * already summed. Lets a line-at-a-time packer price a candidate
 * without re-scanning everything it has accepted so far.
 */
export function estimateTokensFromCounts(chars: number, words: number): number {
  if (chars === 0) return 0;
  return Math.max(Math.ceil(chars / 3.6), Math.ceil(words * 1.4));
}

/**
 * `agent.sessionSectionsMaxTokens: 0` — take the historical
 * {@link SESSION_SECTIONS_BUDGET_SHARE} of `agent.tokenBudget` instead of
 * a fixed ceiling, the same sentinel-means-"derive it"
 * spelling {@link CONVERSATION_CAP_AUTO} uses.
 *
 * A fixed default cannot be the unset value here: the share is what the
 * knob replaces, and anyone who had already moved `agent.tokenBudget`
 * would have their session cap silently snap back to whatever number we
 * picked for a budget of 3000.
 *
 * Every other positive value is enforced as written, with neither end
 * guarded:
 *  - No floor, unlike {@link CONVERSATION_CAP_FLOOR}. That floor exists
 *    because the conversation cap is *derived* — it protects the
 *    transcript from arithmetic the operator never chose. This number is
 *    typed by hand, `0` already means "auto", and so a tiny value is the
 *    only way left to say "drop these two sections". A floor would
 *    silently ignore the figure in the config file, which is the quiet
 *    override this key exists to remove. Below roughly two tokens both
 *    sections vanish with no `[truncated]` marker — pre-existing in
 *    `truncateToTokens`, reachable on `agent.tokenBudget` alone.
 *  - No clamp against the model's context window. `buildPrompt` consumes
 *    this cap before `### world`, the memory sections and
 *    `### loaded-tools` are rendered, so the room the tail actually has
 *    is not known yet; only `computeEffectiveConversationCap`, which
 *    runs after all of them, can subtract them. Clamping here with what
 *    is known at that point would buy a guarantee that is still false,
 *    because `worldSnapshotMaxTokens` sits unclamped in the same tail.
 *    Set above the window this cap squeezes the transcript to
 *    `CONVERSATION_CAP_FLOOR` and then overflows the window; AGENTS.md
 *    says so.
 */
export const SESSION_SECTIONS_CAP_AUTO = 0;

/**
 * Share of `agent.tokenBudget` that bounds `### session-facts` +
 * `### loaded-skills` when `agent.sessionSectionsMaxTokens` is left at
 * {@link SESSION_SECTIONS_CAP_AUTO}. Exported so the config default and
 * the prompt builder cannot drift apart.
 */
export const SESSION_SECTIONS_BUDGET_SHARE = 0.15;

/**
 * Section splits driven by `total` (the `agent.tokenBudget` target for
 * the upper half of the prompt) and optional independent caps that
 * override a share. Semantics per field:
 *  - `stablePrefix`: a `total * 0.35` share nothing reads. Kept because
 *    it is on the public type; see the field's own note. The prefix is
 *    not trimmable — dropping part of `### tools` or `### instructions`
 *    would break tool calling — so there is no cap to enforce here, and
 *    the elastic part of the prefix has its own knob
 *    (`skills.catalogTokenBudget` for the `### skills` catalog).
 *  - `session`: the cap `buildSessionSectionParts` enforces over
 *    `### session-facts` + `### loaded-skills` combined. Falls back to a
 *    `SESSION_SECTIONS_BUDGET_SHARE` share of `total` when the caller
 *    passes nothing or {@link SESSION_SECTIONS_CAP_AUTO}; any other
 *    value is enforced verbatim, with no floor and no clamp against the
 *    model's context window — see {@link SESSION_SECTIONS_CAP_AUTO}.
 *  - `worldSnapshot`: safety-net cap, enforced by `buildPrompt`. Falls
 *    back to a `total * 0.15` share when the caller did not supply one
 *    (keeps existing tests stable during the transition).
 *  - `conversation`: safety-net cap, same fallback policy.
 *
 * `conversation` and `worldSnapshot` live in the variable tail and do
 * NOT invalidate the KV cache when they grow. `session` does not either
 * — `### session-facts` and `### loaded-skills` are tail sections — but
 * it is the one limit `agent.tokenBudget` still moves, which is why it
 * needed a key of its own.
 */
export function defaultBudget(
  total: number,
  caps: {
    session?: number;
    conversation?: number;
    worldSnapshot?: number;
  } = {},
): TokenBudgetLimits {
  return {
    total,
    stablePrefix: Math.floor(total * 0.35),
    // `||`, not `??`: `SESSION_SECTIONS_CAP_AUTO` is `0`, and a caller
    // that passes the sentinel through is asking for the share. Under
    // `??` it would reach `truncateToTokens(text, 0)` and empty both
    // sections — the opposite of what the sentinel means.
    session: caps.session || Math.floor(total * SESSION_SECTIONS_BUDGET_SHARE),
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
 * Most of the window the prompt budget will hold back for the reply.
 *
 * `localModels.completionMaxTokens` is one number for every model the
 * operator runs, and it is routinely raised far past a small model's
 * window (96k for long agent runs, against a 32k local model). Taken
 * verbatim, `computeEffectiveConversationCap` subtracted the whole of it
 * from a window it did not fit in, the result went negative, and the
 * transcript was pinned to `CONVERSATION_CAP_FLOOR` (512 tokens) on every
 * step: the agent forgot everything but the last message, and the reply
 * still could not get the 96k it was budgeted, because the model server
 * stops generating when its window is full.
 *
 * Half the window keeps a configured cap that fits untouched (the default
 * 16384 on a 32k window is exactly half) and splits a window that cannot
 * hold the cap evenly between what the model reads and what it writes.
 */
export const REPLY_RESERVE_MAX_WINDOW_SHARE = 0.5;

/**
 * The reply reservation the prompt budget actually uses on a given
 * window: `completionMaxTokens`, never more than
 * {@link REPLY_RESERVE_MAX_WINDOW_SHARE} of a known window. An unknown
 * window keeps the configured figure (nothing to compare it against),
 * and a non-positive cap (`0`, "no client-side cap") reserves nothing,
 * as before.
 *
 * This is the budget's reservation, not `n_predict`: the request still
 * carries the configured cap, and a local reply may run past this figure
 * into whatever the prompt left free, up to the end of the window.
 */
export function effectiveReplyReserve(
  completionMaxTokens: number,
  contextWindow: number | null | undefined,
): number {
  if (!Number.isFinite(completionMaxTokens) || completionMaxTokens <= 0) {
    return 0;
  }
  if (!contextWindow || contextWindow <= 0) return completionMaxTokens;
  return Math.min(
    completionMaxTokens,
    Math.floor(contextWindow * REPLY_RESERVE_MAX_WINDOW_SHARE),
  );
}

/**
 * Smallest context window in which the agent can actually complete a
 * step: fixed scaffolding + a full generation budget + boundary margin.
 * `contextWindow` below this means every step will hit llama.cpp's
 * context ceiling and come back `truncated`.
 *
 * Given the window being judged, the generation budget is the one the
 * prompt budget really reserves on it (`effectiveReplyReserve`), not the
 * raw cap: a 96k `completionMaxTokens` would otherwise call every window
 * under ~102k "too small" — including the ones the agent runs on fine,
 * because the budget holds the reply to half of them. Without a window
 * (sizing a context that does not exist yet) the full cap still counts.
 */
export function minUsableContextWindow(
  completionMaxTokens: number,
  contextWindow?: number | null,
): number {
  return (
    AGENT_FIXED_PROMPT_TOKENS +
    (contextWindow
      ? effectiveReplyReserve(completionMaxTokens, contextWindow)
      : completionMaxTokens) +
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
 * The conversation cap under `CONVERSATION_CAP_AUTO` when no context
 * window is known — a cloud model nobody has published a length for.
 *
 * 32k was the pre-auto default, chosen when an unknown window mostly
 * meant a small local model. It is now the opposite: a window is
 * unknown precisely when the model is newer than the catalogue
 * snapshot, and those models are large. Holding a fresh 200k model's
 * transcript to 32k drops history nobody asked to lose, and the cost of
 * being wrong the other way is bounded — `computeEffectiveConversationCap`
 * still clamps to the real window the moment one is known, and the
 * packer only spends what the transcript actually holds.
 *
 * 64k is the smallest window in wide use among models a current
 * catalogue misses, so it cannot overshoot a model that is merely new.
 */
export const CONVERSATION_CAP_AUTO_FALLBACK = 64_000;

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
    effectiveReplyReserve(input.completionMaxTokens, input.contextWindow) -
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
