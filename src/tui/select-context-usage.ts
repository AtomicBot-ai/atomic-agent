import { CONVERSATION_SECTION_LABEL } from "./context-usage-from-prompt.js";
import { catalogEntryLookupForKind } from "./providers/providers-model-options.js";
import type { ContextUsageSection, TuiState } from "./tui-state.js";

/**
 * What the composer's context chip and its detail panel draw.
 *
 * Two scales, deliberately kept apart. `contextWindow` is the model's
 * physical ceiling and is often unknown; `conversationCap` is the point
 * at which `packConversation` starts dropping older turns, and is known
 * on every built prompt. The chip gauges the second — it is the one that
 * moves through a session and the one that predicts losing history.
 */
export interface ContextUsageView {
  /** Tokens in the whole last prompt. */
  tokens: number;
  /** The model's window, when anything knows it. */
  contextWindow: number | null;
  /** `tokens` as a share of `contextWindow`, or `null` with no window. */
  percent: number | null;
  /** Tokens the transcript section rendered to. */
  conversationTokens: number;
  /** Ceiling the transcript is packed to, when a prompt has been built. */
  conversationCap: number | null;
  /** Transcript fill as a percentage of that cap. */
  conversationPercent: number | null;
  /** What holds the cap down — drives the panel's "capped by" line. */
  capSource: "config" | "window" | "floor" | "auto" | "pairs" | null;
  /** Macro-turns the prompt carried. */
  pairs: number;
  /** `agent.conversationMaxPairs` in force. */
  pairsCap: number;
  /** Macro-turns dropped whole — the count that matters once the unit is tasks. */
  droppedPairs: number;
  /**
   * Cost of each macro-turn, oldest first. Lets the panel price a
   * different pair count with a prefix sum, so the dial moves the gauge
   * immediately rather than a prompt build later.
   */
  pairCosts: readonly number[];
  /** Fixed cost of everything that is not the transcript. */
  overheadTokens: number;
  /**
   * Turns `packConversation` dropped to make the transcript fit. Any
   * non-zero value is the chip's violet state; the detail view spends
   * the actual number.
   */
  droppedTurns: number;
  sections: readonly ContextUsageSection[];
}

/**
 * Smallest cap `computeEffectiveConversationCap` will return. Hitting it
 * means the window cannot hold the agent's own prompt with room to
 * answer — worth saying outright rather than reporting as a budget.
 */
const CONVERSATION_CAP_FLOOR = 512;

/**
 * Resolve the model's context window.
 *
 * Four sources, in the order of how much they know:
 *
 * 1. The prompt's own `contextWindow` — what the token budget was
 *    actually computed against, straight from the llama-server `/props`
 *    probe. Authoritative wherever it exists.
 * 2. The health poller's reading of the same endpoint. Not redundant:
 *    `localModels.mode: "managed"` *defers* the boot probe, so a local
 *    turn can build its prompt with no window while the poller already
 *    has one.
 * 3. The active cloud provider's catalogue. Read here, at render time,
 *    rather than resolved once into a `ProviderRow`: the live catalogue
 *    arrives from an async fetch at start-up, so anything baked into a
 *    row before it lands freezes a `null` that never recovers. The
 *    lookup prefers live entries over the bundled snapshot, which is the
 *    difference between knowing and not knowing for every model added
 *    since the snapshot was cut.
 * 4. Nothing. `resolveModel`'s nominal 128k default is deliberately not
 *    consulted — a gauge drawn against a guessed scale is a fabrication,
 *    and the panel says "window unknown" instead.
 */
function resolveWindow(state: TuiState): number | null {
  const fromPrompt = state.contextUsage.contextWindow;
  if (fromPrompt !== null && fromPrompt > 0) return fromPrompt;
  const fromPoller = state.llmHealth.contextWindow;
  if (fromPoller !== null && fromPoller > 0) return fromPoller;
  const active = state.providersPanel.rows.find((row) => row.isActiveText);
  if (!active?.chatModel) return null;
  const lookup = catalogEntryLookupForKind(active.kind);
  const entry = lookup?.(active.chatModel);
  if (!entry || entry.kind !== "chat") return null;
  return entry.contextWindow > 0 ? entry.contextWindow : null;
}

/**
 * Which limit is actually holding the transcript down.
 *
 * `computeEffectiveConversationCap` is `max(floor, min(configured,
 * window - everything else))`, so the effective value alone cannot say
 * why it is what it is. Comparing it against the configured cap can:
 * equal means the operator's own setting binds and naming it tells them
 * what to raise, lower means the window binds and no config change will
 * help.
 *
 * The comparison is only valid when there *is* a configured ceiling.
 * Under `auto` the figure sitting in `conversationCapConfigured` is the
 * budget-share fallback for an unknown window, and it is usually the
 * smaller of the two — so the comparison would report "config" and send
 * an operator to raise a setting they have already switched off.
 */
function resolveCapSource(
  cap: number | null,
  configured: number | null,
  auto: boolean,
  boundBy: "pairs" | "tokens" | null,
): ContextUsageView["capSource"] {
  if (cap === null) return null;
  // Above every token branch: when the operator's own task limit is what
  // trimmed history, saying "capped by your conversationMaxTokens" sends
  // them to a setting that would change nothing.
  if (boundBy === "pairs") return "pairs";
  if (cap <= CONVERSATION_CAP_FLOOR) return "floor";
  if (auto) return "auto";
  if (configured !== null && cap < configured) return "window";
  return "config";
}

/**
 * The same readout, recalculated as if the prompt carried `pairs` tasks.
 *
 * Everything outside the transcript is fixed for this turn, so the whole
 * panel — title, percentage, the `conversation` row, `free` — follows
 * from one prefix sum over `pairCosts`. Projecting the view rather than
 * a single number is what lets every figure move together when the
 * operator works the selector; recomputing them one at a time is how
 * two numbers on the same screen end up disagreeing.
 *
 * No prompt build, no LLM call. The costs come from the same
 * over-counting estimator the packer uses, so this and the next real
 * gauge agree.
 */
export function usageAtPairs(
  usage: ContextUsageView,
  pairs: number,
): ContextUsageView {
  const wanted = Math.max(0, Math.min(pairs, usage.pairCosts.length));
  let transcript = 0;
  for (let i = usage.pairCosts.length - wanted; i < usage.pairCosts.length; i += 1) {
    transcript += usage.pairCosts[i] ?? 0;
  }
  const tokens = usage.overheadTokens + transcript;
  return {
    ...usage,
    tokens,
    percent:
      usage.contextWindow === null
        ? null
        : Math.min(100, Math.round((tokens / usage.contextWindow) * 100)),
    conversationTokens: transcript,
    pairs: wanted,
    pairsCap: pairs,
    sections: usage.sections.map((section) =>
      section.label === CONVERSATION_SECTION_LABEL
        ? { ...section, tokens: transcript }
        : section,
    ),
  };
}

export function selectContextUsage(state: TuiState): ContextUsageView | null {
  const {
    tokens,
    droppedTurns,
    sections,
    conversationTokens,
    conversationCap,
    conversationCapConfigured,
    conversationCapAuto,
    conversationPairs,
    conversationPairsCap,
    conversationBoundBy,
    droppedPairs,
    pairCosts,
  } = state.contextUsage;
  // Nothing has been built yet: the chip stays off the bar rather than
  // showing a zero, which would claim the window is empty when what we
  // actually know is nothing.
  if (tokens === null) return null;
  const contextWindow = resolveWindow(state);
  return {
    tokens,
    contextWindow,
    percent:
      contextWindow === null
        ? null
        : Math.min(100, Math.round((tokens / contextWindow) * 100)),
    conversationTokens,
    conversationCap,
    conversationPercent:
      conversationCap === null || conversationCap <= 0
        ? null
        : Math.min(100, Math.round((conversationTokens / conversationCap) * 100)),
    capSource: resolveCapSource(
      conversationCap,
      conversationCapConfigured,
      conversationCapAuto,
      conversationBoundBy,
    ),
    pairs: conversationPairs,
    pairsCap: conversationPairsCap,
    droppedPairs,
    pairCosts,
    overheadTokens: Math.max(0, tokens - conversationTokens),
    droppedTurns,
    sections,
  };
}
