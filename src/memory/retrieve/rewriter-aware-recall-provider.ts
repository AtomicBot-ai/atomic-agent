import { createHash } from "node:crypto";

import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../../agent/agent-loop.js";

import type { QueryRewriterRunner } from "./query-rewriter-runner.js";

/**
 * v2.5 query rewriter (Phase A) — provider decorator.
 *
 * Wraps an inner {@link MemoryContextProvider} (typically the default
 * one produced by `createDefaultMemoryContextProvider`). On every
 * `buildMemoryContext` call:
 *
 *  1. Pull the trailing N user/assistant turn-pairs out of
 *     `input.recentTurns` (set by the agent loop).
 *  2. Hand `{ userMessage, history }` to the runner — at most once per
 *     turn, see below. The runner decides — via the heuristic detector —
 *     whether to fire the LLM call. Fire-safe by construction: a
 *     failure / timeout / abort always returns the original
 *     `userMessage`.
 *  3. Delegate to the inner provider with `userMessage` possibly
 *     replaced by the rewritten query. Nothing else on the input
 *     is mutated; the inner provider's other consumers (`### lessons`,
 *     `### procedures`, the link-graph expansion) see the rewritten
 *     query too, which is desirable: a thematic match against notes
 *     usually matches lessons too.
 *
 * Once per turn. The agent loop refreshes memory context before the
 * first step and again after every step, each time with the same user
 * message. Asking the rewriter every time would repeat an identical
 * request per step — and against a slow provider, repeat its timeout per
 * step, on the hot path. So the outcome is remembered per session, keyed
 * by the user message and the history slice actually sent, and reused
 * for every later refresh with the same key: a timed-out or failed
 * attempt (outcome "use the raw message") included. An attempt whose
 * caller's signal aborted is not remembered — a cancelled turn says
 * nothing about the provider and must not decide the next turn's
 * identical retry.
 *
 * Locked invariants (pinned by tests):
 *  - Disabled-by-default: with `memory.retrieve.rewriter.enabled =
 *    false`, this decorator is never constructed and the provider
 *    chain is byte-identical to pre-v18 behaviour.
 *  - The decorator never touches the main agent slot's KV cache —
 *    that contract is owned by the runner (`slotId = -1`).
 *  - `input.userMessage = null` (no current user message) short-
 *    circuits to direct delegation. Same for empty `recentTurns`.
 *  - One runner call per (session, user message, history slice) while
 *    that key is the session's latest; an aborted attempt is retried.
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

/**
 * Sessions whose latest rewrite is remembered. Each keeps one entry (a
 * digest plus a query of at most a few hundred characters); past this
 * many sessions the least recently used is dropped.
 */
export const REWRITE_MEMO_MAX_SESSIONS = 256;

type HistoryRow = { role: "user" | "assistant"; text: string };

interface RememberedRewrite {
  key: string;
  query: string;
}

export function createRewriterAwareMemoryContextProvider(
  opts: RewriterAwareProviderOptions,
): MemoryContextProvider {
  const memo = new Map<string, RememberedRewrite>();

  const remember = (sessionId: string, entry: RememberedRewrite): void => {
    // Re-insert so Map order tracks recency; the first key is the LRU.
    memo.delete(sessionId);
    memo.set(sessionId, entry);
    if (memo.size > REWRITE_MEMO_MAX_SESSIONS) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
  };

  const rewriteOncePerTurn = async (
    input: MemoryContextProviderInput,
    userMessage: string,
  ): Promise<string> => {
    const history = sliceHistoryForRewriter(
      input.recentTurns ?? [],
      opts.historyTurns,
    );
    const key = rewriteKey(userMessage, history);
    const remembered = memo.get(input.sessionId);
    if (remembered !== undefined && remembered.key === key) {
      remember(input.sessionId, remembered);
      return remembered.query;
    }
    const query = await opts.rewriter.maybeRewrite({
      sessionId: input.sessionId,
      userMessage,
      history,
      signal: input.signal,
    });
    if (!input.signal.aborted) {
      remember(input.sessionId, { key, query });
    }
    return query;
  };

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
      const rewritten = await rewriteOncePerTurn(input, userMessage);
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
 * Digest of exactly what the runner would be asked: the message and the
 * sliced history, projected to `[role, text]` so extra fields on a row
 * cannot split one request into two keys.
 */
function rewriteKey(userMessage: string, history: readonly HistoryRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([userMessage, history.map((row) => [row.role, row.text])]),
    )
    .digest("hex");
}

/**
 * Take the last `historyTurns` user/assistant **pairs**. We accept
 * `ConversationTurn`-shaped rows where each row already carries
 * `role: "user" | "assistant"` plus `text` — the agent loop projects
 * its richer `ConversationTurn` union into this shape so the
 * rewriter never has to know about tool-call rows.
 */
function sliceHistoryForRewriter(
  turns: readonly HistoryRow[],
  historyTurns: number,
): readonly HistoryRow[] {
  if (historyTurns <= 0 || turns.length === 0) return [];
  // historyTurns counts pairs; each pair is 2 turn rows.
  const max = historyTurns * 2;
  return turns.length > max ? turns.slice(turns.length - max) : turns;
}
