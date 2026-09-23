import { describe, expect, it, vi } from "vitest";

import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../../agent/agent-loop.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";

import {
  REWRITER_SLOT_ID,
  type RewriterLlmComplete,
  createQueryRewriterRunner,
} from "./query-rewriter-runner.js";
import {
  REWRITE_MEMO_MAX_SESSIONS,
  createRewriterAwareMemoryContextProvider,
} from "./rewriter-aware-recall-provider.js";
import { createAlwaysGate } from "./rewriter-gate.js";

// The agent loop refreshes memory context before the first step and after
// every step with the same user message. These tests drive the decorator
// the same way, through a real runner, and count what reaches the LLM.

const EMPTY_CTX: MemoryContext = { recalled: [], index: [] };

type Row = { role: "user" | "assistant"; text: string };

const HISTORY: readonly Row[] = [
  { role: "user", text: "Redis vs memcached for sessions" },
  { role: "assistant", text: "Redis, because it persists" },
];

function rewrite(body: string): CompletionResult {
  return {
    content: `<rewritten_query>${body}</rewritten_query>`,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {} as never,
    cacheHitTokens: 0,
    slotId: REWRITER_SLOT_ID,
    modelId: null,
  } as CompletionResult;
}

function setup(complete: RewriterLlmComplete, timeoutMs = 1_000) {
  const llm = vi.fn(complete);
  const outcomes: string[] = [];
  const recallQueries: (string | null)[] = [];
  const inner: MemoryContextProvider = {
    async buildMemoryContext(input) {
      recallQueries.push(input.userMessage);
      return EMPTY_CTX;
    },
  };
  const provider = createRewriterAwareMemoryContextProvider({
    inner,
    rewriter: createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs,
      gate: createAlwaysGate(),
      emitTrace: (event) => outcomes.push(event.outcome),
    }),
    historyTurns: 3,
  });
  return { llm, outcomes, recallQueries, provider };
}

function refresh(
  userMessage: string,
  over: {
    sessionId?: string;
    signal?: AbortSignal;
    recentTurns?: readonly Row[];
  } = {},
): MemoryContextProviderInput {
  return {
    sessionId: over.sessionId ?? "s",
    userMessage,
    signal: over.signal ?? new AbortController().signal,
    recentTurns: over.recentTurns ?? HISTORY,
  };
}

async function refreshes(
  provider: MemoryContextProvider,
  n: number,
  input: () => MemoryContextProviderInput,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await provider.buildMemoryContext(input());
  }
}

describe("rewriter-aware provider — once per turn", () => {
  it("asks the LLM once across every refresh of the same turn", async () => {
    const { llm, outcomes, recallQueries, provider } = setup(async () =>
      rewrite("did they pick Redis for sessions"),
    );
    const signal = new AbortController().signal;
    await refreshes(provider, 6, () => refresh("did they?", { signal }));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["ok"]);
    // Every step still recalls with the rewritten query.
    expect(recallQueries).toEqual(
      Array(6).fill("did they pick Redis for sessions"),
    );
  });

  it("does not retry a timed-out rewrite on the next refresh", async () => {
    const { llm, outcomes, recallQueries, provider } = setup(
      () => new Promise<CompletionResult>(() => {}),
      10,
    );
    await refreshes(provider, 4, () => refresh("did they?"));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["timeout"]);
    expect(recallQueries).toEqual(Array(4).fill("did they?"));
  });

  it("does not retry a failed rewrite on the next refresh", async () => {
    const { llm, outcomes, provider } = setup(async () => {
      throw new Error("provider 500");
    });
    await refreshes(provider, 3, () => refresh("did they?"));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["failed"]);
  });

  it("rewrites again for a new user message", async () => {
    const { llm, provider } = setup(async (p) =>
      rewrite(p.prompt.includes("and memcached?") ? "memcached" : "Redis"),
    );
    await refreshes(provider, 2, () => refresh("did they?"));
    await refreshes(provider, 2, () => refresh("and memcached?"));
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("rewrites again when the history slice changes", async () => {
    const { llm, provider } = setup(async () => rewrite("Redis"));
    await provider.buildMemoryContext(refresh("did they?"));
    await provider.buildMemoryContext(
      refresh("did they?", {
        recentTurns: [
          ...HISTORY,
          { role: "user", text: "did they?" },
          { role: "assistant", text: "yes, Redis" },
        ],
      }),
    );
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("does not remember an attempt the caller aborted", async () => {
    const turn = new AbortController();
    let calls = 0;
    const { llm, outcomes, recallQueries, provider } = setup((p) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(rewrite("Redis for sessions"));
      return new Promise<CompletionResult>((_, reject) => {
        p.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        turn.abort();
      });
    });
    await provider.buildMemoryContext(
      refresh("did they?", { signal: turn.signal }),
    );
    expect(outcomes).toEqual(["aborted"]);
    // The next turn asks the identical question with a live signal: it
    // must reach the LLM, and its answer is the one remembered.
    const next = new AbortController().signal;
    await refreshes(provider, 3, () => refresh("did they?", { signal: next }));
    expect(llm).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(["aborted", "ok"]);
    expect(recallQueries.slice(1)).toEqual(Array(3).fill("Redis for sessions"));
  });

  it("keeps each session's rewrite separate", async () => {
    const { llm, provider } = setup(async (p) => rewrite(p.sessionId));
    await provider.buildMemoryContext(refresh("did they?", { sessionId: "a" }));
    await provider.buildMemoryContext(refresh("did they?", { sessionId: "b" }));
    await provider.buildMemoryContext(refresh("did they?", { sessionId: "a" }));
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("forgets the least recently used session past the cap", async () => {
    const { llm, provider } = setup(async () => rewrite("Redis"));
    for (let i = 0; i <= REWRITE_MEMO_MAX_SESSIONS; i += 1) {
      await provider.buildMemoryContext(
        refresh("did they?", { sessionId: `s${i}` }),
      );
    }
    expect(llm).toHaveBeenCalledTimes(REWRITE_MEMO_MAX_SESSIONS + 1);
    // The newest session is still remembered …
    await provider.buildMemoryContext(
      refresh("did they?", { sessionId: `s${REWRITE_MEMO_MAX_SESSIONS}` }),
    );
    expect(llm).toHaveBeenCalledTimes(REWRITE_MEMO_MAX_SESSIONS + 1);
    // … the first one was dropped and asks again.
    await provider.buildMemoryContext(refresh("did they?", { sessionId: "s0" }));
    expect(llm).toHaveBeenCalledTimes(REWRITE_MEMO_MAX_SESSIONS + 2);
  });
});
