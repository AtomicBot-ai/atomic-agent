import type { AtomicAgentConfig } from "../../config/index.js";
import type { ContextUsageState } from "../../session/index.js";
import {
  CONVERSATION_CAP_AUTO,
  computeEffectiveConversationCap,
  estimateTokens,
} from "../../prompt/token-budget.js";

/**
 * Would the session's next prompt, built for a local link, trigger
 * automatic compaction (ATO-2537)? The local-first cascade leaves such a
 * turn in the cloud: the prompt and compaction are sized to the turn's
 * head, so a long cloud session started on a small local window would be
 * compacted down to it.
 *
 * Mirrors the real trigger (`decideCompaction`): history, not the whole
 * prompt, against `triggerRatio` of the history allowance, which is the
 * window minus the fixed part of the prompt, the reply reserve and the
 * safety margin (`computeEffectiveConversationCap`, the same function the
 * prompt build uses).
 */

/** The facts about a session's size the check needs. */
export interface LocalFirstSessionSize {
  /** History the next prompt carries: transcript, context summary, the new message. */
  historyTokens: number;
  /** Everything else the last prompt carried: scaffold, tools, memory, policy. */
  fixedTokens: number;
}

/**
 * With no known local window, history past this keeps the turn in the
 * cloud. Right after a restart the live window is unknown until the local
 * link serves once; a long resumed session is the case this check exists
 * for, so an unknown window is not taken as "it fits". 8k of history is
 * past the compaction trigger of a 16k window and well under a 32k one's.
 */
export const UNKNOWN_WINDOW_HISTORY_LIMIT = 8_000;

const CONTEXT_SUMMARY_LABEL = "context summary";

/**
 * The session's size from its last built prompt plus the new message.
 * Null when no prompt was built yet: a new session is small.
 *
 * Read from the per-section estimates, not `usage.tokens`, which the
 * provider's own count replaces once a step completes: mixing that count
 * with the estimated transcript would put the error on the fixed part.
 */
export function localFirstSessionSize(
  usage: Pick<ContextUsageState, "tokens" | "conversationTokens" | "sections"> | null | undefined,
  userMessage: string,
): LocalFirstSessionSize | null {
  if (usage === null || usage === undefined) return null;
  if (usage.tokens === null || !(usage.tokens > 0)) return null;
  const summary = usage.sections.find((s) => s.label === CONTEXT_SUMMARY_LABEL)?.tokens ?? 0;
  const transcript = Math.max(0, usage.conversationTokens);
  const total = usage.sections.reduce((sum, s) => sum + Math.max(0, s.tokens), 0);
  return {
    historyTokens: transcript + summary + estimateTokens(userMessage),
    fixedTokens: Math.max(0, total - transcript - summary),
  };
}

/**
 * Whether the history stays under the compaction trigger on a local
 * window. The fixed part is the cloud prompt's: a local prompt is
 * usually no larger, so the error leans toward staying in the cloud.
 */
export function fitsLocalWindow(
  size: LocalFirstSessionSize | null,
  contextWindow: number | null,
  config: Pick<AtomicAgentConfig, "agent" | "localModels">,
): boolean {
  if (size === null) return true;
  const compaction = config.agent.compaction;
  if (!compaction.auto) return true;
  if (contextWindow === null || !(contextWindow > 0)) {
    return size.historyTokens <= UNKNOWN_WINDOW_HISTORY_LIMIT;
  }
  const configuredCap = config.agent.conversationMaxTokens;
  const local = config.localModels;
  const cap = computeEffectiveConversationCap({
    configuredCap,
    ...(configuredCap <= CONVERSATION_CAP_AUTO ? { autoFill: true } : {}),
    contextWindow,
    stablePrefixTokens: size.fixedTokens,
    sessionTokens: 0,
    worldSnapshotTokens: 0,
    completionMaxTokens: local.completionMaxTokens,
    reasoningBudgetTokens: local.thinking !== "off" ? local.reasoningBudgetTokens : 0,
  });
  return size.historyTokens < cap * compaction.triggerRatio;
}
