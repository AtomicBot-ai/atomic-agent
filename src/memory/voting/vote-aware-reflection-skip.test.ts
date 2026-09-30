import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";

import { MemoryStore } from "../memory-store.js";
import type { ReflectionRunner } from "../reflection/reflection-runner.js";

import { VoteStore } from "./vote-store.js";
import { createVoteRunner } from "./vote-runner.js";
import type { VoteRunner, VoteTraceEvent } from "./vote-runner.js";
import { createVoteAwareReflectionRunner } from "./vote-aware-reflection.js";

/**
 * A vote sub-call that never fires must not look like one that is
 * switched off. Two routes in the decorator returned before
 * `voteRunner.run()` with nothing in the trace behind them: a
 * hydration throw (logged only) and an empty candidate set (silent).
 *
 * Unlike link-gen (PR #496) the empty set cannot be delegated to the
 * runner: `runOne`'s `minCandidates` gate reports `skipped` in its
 * *result* and a debug log, and the runner's trace sink carries only
 * per-vote rows — forwarding would leave the trace exactly as mute.
 * So the decorator emits both rows itself, and these pin what a trace
 * reader has to be able to separate on the routes that never reach the
 * runner: nothing was surfaced, ids were surfaced and hydrated into
 * nothing, and the stores could not be read.
 *
 * Scope, so nobody reads more into these than they pin: a *missing*
 * `vote` row still has more than one cause, because `runOne`'s
 * `finish()` writes no row either — see `TraceVote` in
 * `trace-event.ts`.
 */

interface Fixture {
  dir: string;
  db: Database.Database;
  memoryStore: MemoryStore;
  voteStore: VoteStore;
  ids: number[];
  dispose(): void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vote-skip-"));
  const dbFile = join(dir, "memory.sqlite");
  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000 },
  });
  const ids = [
    memoryStore.store({ content: "alpha" }).id,
    memoryStore.store({ content: "beta" }).id,
  ];
  const db = new DatabaseCtor(dbFile);
  db.pragma("foreign_keys = ON");
  const voteStore = new VoteStore({ db });
  return {
    dir,
    db,
    memoryStore,
    voteStore,
    ids,
    dispose() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        memoryStore.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const INNER: ReflectionRunner = {
  async reflect() {
    /* no-op */
  },
  abortPending() {
    /* no-op */
  },
};

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 0,
      predictedTokens: 0,
    },
    cacheHitTokens: 0,
    slotId: 7,
    modelId: null,
  };
}

describe("vote-aware reflection reports the turns it drops", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.dispose();
  });

  /** A `memoryStore` whose reads die the way a closed handle does. */
  function deadStore(): MemoryStore {
    return new Proxy(fx.memoryStore, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return () => {
            throw new TypeError("The database connection is not open");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as MemoryStore;
  }

  /** Records what reached the runner without asking an LLM. */
  function stubRunner(calls: number[]): VoteRunner {
    return {
      async run(input) {
        calls.push(input.candidates.length);
        return { outcome: "ok", applied: 1, rejected: 0 };
      },
      abortPending() {
        /* no-op */
      },
    };
  }

  function build(args: {
    memoryStore: MemoryStore;
    voteRunner: VoteRunner;
    emitTrace: (event: VoteTraceEvent) => void;
  }) {
    return createVoteAwareReflectionRunner({
      reflection: INNER,
      voteRunner: args.voteRunner,
      memoryStore: args.memoryStore,
      lessonStore: null,
      profileStore: null,
      emitTrace: args.emitTrace,
    });
  }

  it("emits a failed trace naming hydration when the store throws", async () => {
    const traces: VoteTraceEvent[] = [];
    const calls: number[] = [];
    const runner = build({
      memoryStore: deadStore(),
      voteRunner: stubRunner(calls),
      emitTrace: (event) => traces.push(event),
    });

    await expect(
      runner.reflect({
        sessionId: "s1",
        userMessage: "u",
        assistantReply: "a",
        recalledMemoryIds: fx.ids,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(traces).toHaveLength(1);
    const event = traces[0]!;
    expect(event.type).toBe("run");
    expect(event.sessionId).toBe("s1");
    if (event.type !== "run") throw new Error("expected a run-level event");
    // Not `skipped`: the candidate set was never the problem.
    expect(event.outcome).toBe("failed");
    expect(event.reason).toContain("hydration");
    expect(event.reason).toContain("The database connection is not open");
  });

  it("emits a skipped trace with candidates=0 when nothing surfaced", async () => {
    const traces: VoteTraceEvent[] = [];
    const calls: number[] = [];
    const runner = build({
      memoryStore: fx.memoryStore,
      voteRunner: stubRunner(calls),
      emitTrace: (event) => traces.push(event),
    });

    await runner.reflect({
      sessionId: "s2",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: [],
    });

    expect(calls).toEqual([]);
    expect(traces).toHaveLength(1);
    const event = traces[0]!;
    if (event.type !== "run") throw new Error("expected a run-level event");
    // The skip is reported as a skip — distinguishable from the
    // hydration failure above, and from no row at all.
    expect(event.outcome).toBe("skipped");
    expect(event.candidates).toBe(0);
    expect(event.reason).not.toContain("hydration");
    // Nothing was surfaced, and the reason says so with the number.
    expect(event.reason).toBe("candidates=0 of 0 surfaced ids");
  });

  it("separates surfaced-but-unhydratable ids from nothing surfaced", async () => {
    const traces: VoteTraceEvent[] = [];
    const calls: number[] = [];
    const runner = build({
      memoryStore: fx.memoryStore,
      voteRunner: stubRunner(calls),
      emitTrace: (event) => traces.push(event),
    });
    // The evicted-row shape: the id was surfaced, the row is gone.
    const missing = Math.max(...fx.ids) + 500;

    await runner.reflect({
      sessionId: "s3",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: [missing],
    });

    expect(calls).toEqual([]);
    expect(traces.map((t) => t.type)).toEqual(["run"]);
    const event = traces[0]!;
    if (event.type !== "run") throw new Error("expected a run-level event");
    expect(event.outcome).toBe("skipped");
    // The same `skipped { candidates: 0 }` as the turn that surfaced
    // nothing, so the reason is the only thing that can tell a reader
    // the stores dropped an id they were handed.
    expect(event.reason).toBe("candidates=0 of 1 surfaced ids");
  });

  it("keeps reflect() fire-safe when the trace sink itself throws", async () => {
    // Both routes run during runtime shutdown, when the recorder the
    // bootstrap sink resolves may already be gone — and the agent loop
    // calls `reflect()` as a bare `void`.
    let sinkCalls = 0;
    const throwingSink = () => {
      sinkCalls += 1;
      throw new Error("recorder is gone");
    };

    const onFailure = build({
      memoryStore: deadStore(),
      voteRunner: stubRunner([]),
      emitTrace: throwingSink,
    });
    await expect(
      onFailure.reflect({
        sessionId: "s4",
        userMessage: "u",
        assistantReply: "a",
        recalledMemoryIds: fx.ids,
      }),
    ).resolves.toBeUndefined();

    const onSkip = build({
      memoryStore: fx.memoryStore,
      voteRunner: stubRunner([]),
      emitTrace: throwingSink,
    });
    await expect(
      onSkip.reflect({
        sessionId: "s5",
        userMessage: "u",
        assistantReply: "a",
        recalledMemoryIds: [],
      }),
    ).resolves.toBeUndefined();

    // Not vacuous: the sink really was reached on both routes and
    // really did throw each time.
    expect(sinkCalls).toBe(2);
  });

  it("adds no run row on the healthy path — the runner's votes are the stream", async () => {
    // One sink, one event type: the decorator must not double-report a
    // turn the runner already narrates vote by vote.
    const traces: VoteTraceEvent[] = [];
    const voteRunner = createVoteRunner({
      llmComplete: async () => completion(`UPVOTE memory:${fx.ids[0]!}\n`),
      voteStore: fx.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 5,
      eventLogMaxRows: 0,
      emitTrace: (event) => traces.push(event),
    });
    const runner = build({
      memoryStore: fx.memoryStore,
      voteRunner,
      emitTrace: (event) => traces.push(event),
    });

    await runner.reflect({
      sessionId: "s6",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: fx.ids,
    });

    expect(traces.map((t) => t.type)).toEqual(["applied"]);
  });
});
