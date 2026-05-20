import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../../agent/agent-loop.js";

import type {
  QueryRewriterRunner,
} from "./query-rewriter-runner.js";

/**
 * memU-inspired query rewriter (Phase A) — provider decorator.
 *
 * Wraps an inner {@link MemoryContextProvider} (typically the default
 * one produced by `createDefaultMemoryContextProvider`). On every
 * `buildMemoryContext` call:
 *
 *  1. Pull the trailing N user/assistant turn-pairs out of
 *     `input.recentTurns` (set by the agent loop).
 *  2. Hand `{ userMessage, history }` to the runner. The runner
 *     decides — via the heuristic detector — whether to fire the
 *     LLM call. Fire-safe by construction: a failure / timeout /
 *     abort always returns the original `userMessage`.
 *  3. Delegate to the inner provider with `userMessage` possibly
 *     replaced by the rewritten query. Nothing else on the input
 *     is mutated; the inner provider's other consumers (`### lessons`,
 *     `### procedures`, the link-graph expansion) see the rewritten
 *     query too, which is desirable: a thematic match against notes
 *     usually matches lessons too.
 *
 * Locked invariants (pinned by tests):
 *  - Disabled-by-default: with `memory.retrieve.rewriter.enabled =
 *    false`, this decorator is never constructed and the provider
 *    chain is byte-identical to pre-v18 behaviour.
 *  - The decorator never touches the main agent slot's KV cache —
 *    that contract is owned by the runner (`slotId = -1`).
 *  - `input.userMessage = null` (no current user message) short-
 *    circuits to direct delegation. Same for empty `recentTurns`.
 */
export interface RewriterAwareProviderOptions {
  inner: MemoryContextProvider;
  rewriter: QueryRewriterRunner;
  /**
   * How many trailing turn-pairs (user + assistant) to feed into the
   * rewriter as context. The provider slices `input.recentTurns` to
   * the last `historyTurns * 2` entries before handing them off.
   */
  historyTurns: number;
}

export function createRewriterAwareMemoryContextProvider(
  opts: RewriterAwareProviderOptions,
): MemoryContextProvider {
  return {
    async buildMemoryContext(
      input: MemoryContextProviderInput,
    ): Promise<MemoryContext> {
      const userMessage = input.userMessage;
      // No current user message ⇒ no recall query to rewrite; defer
      // entirely. This matches the agent-loop refresh path that fires
      // between steps (subsequent refreshes after the user's message
      // arrived in step 0 keep the original userMessage on input).
      if (userMessage === null || userMessage.length === 0) {
        return opts.inner.buildMemoryContext(input);
      }
      const history = sliceHistoryForRewriter(
        input.recentTurns ?? [],
        opts.historyTurns,
      );
      const rewritten = await opts.rewriter.maybeRewrite({
        sessionId: input.sessionId,
        userMessage,
        history,
        signal: input.signal,
      });
      if (rewritten === userMessage) {
        return opts.inner.buildMemoryContext(input);
      }
      return opts.inner.buildMemoryContext({
        ...input,
        userMessage: rewritten,
      });
    },
  };
}

/**
 * Take the last `historyTurns` user/assistant **pairs**. We accept
 * `ConversationTurn`-shaped rows where each row already carries
 * `role: "user" | "assistant"` plus `text` — the agent loop projects
 * its richer `ConversationTurn` union into this shape so the
 * rewriter never has to know about tool-call rows.
 */
function sliceHistoryForRewriter(
  turns: readonly { role: "user" | "assistant"; text: string }[],
  historyTurns: number,
): readonly { role: "user" | "assistant"; text: string }[] {
  if (historyTurns <= 0 || turns.length === 0) return [];
  // historyTurns counts pairs; each pair is 2 turn rows.
  const max = historyTurns * 2;
  return turns.length > max ? turns.slice(turns.length - max) : turns;
}
