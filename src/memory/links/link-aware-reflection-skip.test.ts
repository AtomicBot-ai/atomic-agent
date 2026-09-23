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
