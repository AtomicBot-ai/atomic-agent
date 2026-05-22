import { describe, expect, it, vi } from "vitest";

import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../../agent/agent-loop.js";

import type { QueryRewriterRunner } from "./query-rewriter-runner.js";
import { createRewriterAwareMemoryContextProvider } from "./rewriter-aware-recall-provider.js";

const EMPTY_CTX: MemoryContext = { recalled: [], index: [] };

function makeInner(): {
  provider: MemoryContextProvider;
  calls: MemoryContextProviderInput[];
} {
  const calls: MemoryContextProviderInput[] = [];
  return {
    calls,
    provider: {
      buildMemoryContext: vi
        .fn()
        .mockImplementation(async (input: MemoryContextProviderInput) => {
          calls.push(input);
          return EMPTY_CTX;
        }),
    },
  };
}

function inputFor(
  userMessage: string | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] = [],
): MemoryContextProviderInput {
  return {
    sessionId: "s",
    userMessage,
    signal: new AbortController().signal,
    recentTurns,
  };
}

describe("createRewriterAwareMemoryContextProvider", () => {
  it("passes the rewritten query through to the inner provider", async () => {
    const { provider, calls } = makeInner();
    const rewriter: QueryRewriterRunner = {
      maybeRewrite: vi.fn().mockResolvedValue("FTS5 ranking algorithm"),
    };
    const decorated = createRewriterAwareMemoryContextProvider({
      inner: provider,
      rewriter,
      historyTurns: 3,
    });
    await decorated.buildMemoryContext(
      inputFor("and what about it", [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe("FTS5 ranking algorithm");
  });

  it("delegates with the original input when the rewriter returns the raw message", async () => {
    const { provider, calls } = makeInner();
    const rewriter: QueryRewriterRunner = {
      maybeRewrite: vi.fn().mockResolvedValue("plain self-contained question"),
    };
    const decorated = createRewriterAwareMemoryContextProvider({
      inner: provider,
      rewriter,
      historyTurns: 3,
    });
    await decorated.buildMemoryContext(
      inputFor("plain self-contained question", [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ]),
    );
    expect(calls[0]!.userMessage).toBe("plain self-contained question");
  });

  it("short-circuits to direct delegation when userMessage is null", async () => {
    const { provider } = makeInner();
    const rewriter: QueryRewriterRunner = {
      maybeRewrite: vi.fn(),
    };
    const decorated = createRewriterAwareMemoryContextProvider({
      inner: provider,
      rewriter,
      historyTurns: 3,
    });
    await decorated.buildMemoryContext(inputFor(null));
    expect(rewriter.maybeRewrite).not.toHaveBeenCalled();
  });

  it("short-circuits to direct delegation when userMessage is empty", async () => {
    const { provider } = makeInner();
    const rewriter: QueryRewriterRunner = {
      maybeRewrite: vi.fn(),
    };
    const decorated = createRewriterAwareMemoryContextProvider({
      inner: provider,
      rewriter,
      historyTurns: 3,
    });
    await decorated.buildMemoryContext(
      inputFor("", [
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ]),
    );
    expect(rewriter.maybeRewrite).not.toHaveBeenCalled();
  });

  it("slices recentTurns to historyTurns * 2 (trailing pairs)", async () => {
    const { provider } = makeInner();
    let capturedHistory: unknown;
    const rewriter: QueryRewriterRunner = {
      maybeRewrite: vi.fn().mockImplementation(async (req) => {
        capturedHistory = req.history;
        return req.userMessage;
      }),
    };
    const decorated = createRewriterAwareMemoryContextProvider({
      inner: provider,
      rewriter,
      historyTurns: 2, // 2 pairs ⇒ 4 trailing rows
    });
    const turns = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ] as const;
    await decorated.buildMemoryContext(inputFor("и что", turns));
    expect(capturedHistory).toEqual([
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ]);
  });
});
