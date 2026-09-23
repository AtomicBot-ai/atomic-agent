import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";

import { MemoryStore } from "../memory-store.js";
import type { ReflectionRunner } from "../reflection/reflection-runner.js";

import { LinkStore } from "./link-store.js";
import { createLinkGeneratorRunner } from "./link-generator-runner.js";
import type { LinkGeneratorTraceEvent } from "./link-generator-runner.js";
import { createLinkAwareReflectionRunner } from "./link-aware-reflection.js";

/**
 * A link-gen that never fires must not look like a link-gen that is
 * switched off. The decorator used to `return` on both of its
 * too-few-candidates gates — no trace, no metric, no log — while the
 * runner's own `minCandidates` guard (which DOES emit `skipped`) sat
 * unreachable behind them. Three weeks of empty `memory_links` read
 * exactly like a disabled feature from the outside.
 *
 * These pin the delegation: the decorator forwards the short
 * candidate set, the runner reports the skip with a reason, and the
 * LLM is still never called.
 *
 * The second block pins the one route that survived that change: a
 * hydration throw returns before `generate()` is reached, so nothing
 * downstream can narrate it. The decorator emits `failed` itself, and
 * the reason must say hydration — reporting it as `skipped` would be
 * the same silence with a nicer label.
 */

interface Fixture {
  dir: string;
  db: Database.Database;
  notesStore: MemoryStore;
  linkStore: LinkStore;
  ids: number[];
  dispose(): void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "link-skip-"));
  const dbFile = join(dir, "memory.sqlite");
  const notesStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000 },
  });
  const ids = [
    notesStore.store({ content: "alpha" }).id,
    notesStore.store({ content: "beta" }).id,
  ];
  const db = new DatabaseCtor(dbFile);
  db.pragma("foreign_keys = ON");
  const linkStore = new LinkStore({ db });
  return {
    dir,
    db,
    notesStore,
    linkStore,
    ids,
    dispose() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        notesStore.close();
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

describe("link-aware reflection reports its skips", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.dispose();
  });

  function build(traces: LinkGeneratorTraceEvent[], onLlm: () => void) {
    const linkGenerator = createLinkGeneratorRunner({
      llmComplete: async () => {
        onLlm();
        throw new Error("the LLM must not be reached on a skip");
      },
      linkStore: fx.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      minCandidates: 2,
      emitTrace: (event) => traces.push(event),
    });
    return createLinkAwareReflectionRunner({
      reflection: INNER,
      linkGenerator,
      notesStore: fx.notesStore,
      minCandidates: 2,
    });
  }

  it("emits a skipped trace when too few ids were surfaced", async () => {
    const traces: LinkGeneratorTraceEvent[] = [];
    let llmCalls = 0;
    const runner = build(traces, () => {
      llmCalls += 1;
    });

    await runner.reflect({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: [fx.ids[0]!],
    });

    expect(llmCalls).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.outcome).toBe("skipped");
    expect(traces[0]!.sessionId).toBe("s1");
    expect(traces[0]!.reason).toContain("minCandidates");
  });

  it("emits a skipped trace when the ids hydrate into too few rows", async () => {
    const traces: LinkGeneratorTraceEvent[] = [];
    let llmCalls = 0;
    const runner = build(traces, () => {
      llmCalls += 1;
    });
    // Two ids, but one is gone — the evicted-row shape.
    const missing = Math.max(...fx.ids) + 500;

    await runner.reflect({
      sessionId: "s2",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: [fx.ids[0]!, missing],
    });

    expect(llmCalls).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.outcome).toBe("skipped");
    expect(traces[0]!.reason).toContain("minCandidates");
  });

  it("does not read the store when the id list is already too short", async () => {
    const traces: LinkGeneratorTraceEvent[] = [];
    let reads = 0;
    const counting = new Proxy(fx.notesStore, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (id: number) => {
            reads += 1;
            return target.get(id);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as MemoryStore;

    const linkGenerator = createLinkGeneratorRunner({
      llmComplete: async () => {
        throw new Error("the LLM must not be reached on a skip");
      },
      linkStore: fx.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      minCandidates: 2,
      emitTrace: (event) => traces.push(event),
    });
    const runner = createLinkAwareReflectionRunner({
      reflection: INNER,
      linkGenerator,
      notesStore: counting,
      minCandidates: 2,
    });

    await runner.reflect({
      sessionId: "s3",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: [fx.ids[0]!],
    });

    expect(reads).toBe(0);
    expect(traces.map((t) => t.outcome)).toEqual(["skipped"]);
  });
});

describe("link-aware reflection reports hydration failures", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.dispose();
  });

  /** A `notesStore` whose reads die the way a closed handle does. */
  function deadStore(): MemoryStore {
    return new Proxy(fx.notesStore, {
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

  function build(args: {
    notesStore: MemoryStore;
    emitTrace: (event: LinkGeneratorTraceEvent) => void;
    onLlm?: () => void;
  }) {
    const linkGenerator = createLinkGeneratorRunner({
      llmComplete: async () => {
        args.onLlm?.();
        throw new Error("llm-side boom");
      },
      linkStore: fx.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      minCandidates: 2,
      emitTrace: args.emitTrace,
    });
    return createLinkAwareReflectionRunner({
      reflection: INNER,
      linkGenerator,
      notesStore: args.notesStore,
      minCandidates: 2,
      emitTrace: args.emitTrace,
    });
  }

  it("emits a failed trace naming hydration when the store throws", async () => {
    const traces: LinkGeneratorTraceEvent[] = [];
    let llmCalls = 0;
    const runner = build({
      notesStore: deadStore(),
      emitTrace: (event) => traces.push(event),
      onLlm: () => {
        llmCalls += 1;
      },
    });

    await expect(
      runner.reflect({
        sessionId: "s4",
        userMessage: "u",
        assistantReply: "a",
        recalledMemoryIds: fx.ids,
      }),
    ).resolves.toBeUndefined();

    expect(llmCalls).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.sessionId).toBe("s4");
    // Not `skipped`: the candidate set was never the problem.
    expect(traces[0]!.outcome).toBe("failed");
    expect(traces[0]!.reason).toContain("hydration");
    expect(traces[0]!.reason).toContain("The database connection is not open");
  });

  it("keeps reflect() fire-safe when the trace sink itself throws", async () => {
    // Both the log and the trace run during runtime shutdown, when the
    // recorder the bootstrap sink resolves may already be gone.
    let sinkCalls = 0;
    const runner = build({
      notesStore: deadStore(),
      emitTrace: () => {
        sinkCalls += 1;
        throw new Error("recorder is gone");
      },
    });

    await expect(
      runner.reflect({
        sessionId: "s5",
        userMessage: "u",
        assistantReply: "a",
        recalledMemoryIds: fx.ids,
      }),
    ).resolves.toBeUndefined();
    // Not vacuous: the sink really was reached and really did throw.
    expect(sinkCalls).toBe(1);
  });

  it("still emits exactly one event on the healthy path", async () => {
    // The decorator's sink must not double-report a run the runner
    // already narrates — one call, one event, from the runner.
    const traces: LinkGeneratorTraceEvent[] = [];
    const runner = build({
      notesStore: fx.notesStore,
      emitTrace: (event) => traces.push(event),
    });

    await runner.reflect({
      sessionId: "s6",
      userMessage: "u",
      assistantReply: "a",
      recalledMemoryIds: fx.ids,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]!.outcome).toBe("failed");
    // The runner's own LLM-side failure — no hydration prefix.
    expect(traces[0]!.reason).toBe("llm-side boom");
  });
});
