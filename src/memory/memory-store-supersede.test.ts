import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMemoryContextProvider } from "./memory-context-provider.js";
import { MemoryStore } from "./memory-store.js";

describe("superseded notes (ATO-672)", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-memory-supersede-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("list({ excludeTags }) drops rows carrying the tag", () => {
    const a = store.store({ content: "works at Acme", tags: ["reflection"] });
    store.store({ content: "works at Globex" });
    store.evolveTags(a.id, ["superseded"], { leaseMs: 0 });
    expect(store.list({ excludeTags: ["superseded"] }).map((e) => e.content)).toEqual([
      "works at Globex",
    ]);
    expect(store.list()).toHaveLength(2);
  });

  it("findSimilar does not count as a recall", () => {
    const a = store.store({ content: "the user works at Acme" });
    const hits = store.findSimilar("the user works at Globex", 5);
    expect(hits.map((e) => e.id)).toContain(a.id);
    expect(store.get(a.id)!.recallCount).toBe(0);
  });

  it("the context provider hides superseded notes only when asked", async () => {
    const old = store.store({ content: "lisbon office address" });
    store.store({ content: "lisbon office moved to the new address" });
    store.evolveTags(old.id, ["superseded"], { leaseMs: 0 });
    const input = {
      sessionId: "s1",
      userMessage: "lisbon office",
      toolResultSummaries: [],
      signal: new AbortController().signal,
    };
    const build = async (hideSuperseded: boolean) =>
      (await createDefaultMemoryContextProvider({
        store,
        recall: { enabled: true, k: 5 },
        index: { enabled: true, limit: 20, previewChars: 80 },
        ...(hideSuperseded ? { hideSuperseded: true } : {}),
      }).buildMemoryContext(input)) as unknown as {
        recalled: Array<{ id: number }>;
        index: Array<{ id: number }>;
      };
    const on = await build(true);
    expect(on.recalled.map((e) => e.id)).not.toContain(old.id);
    expect(on.index.map((e) => e.id)).not.toContain(old.id);
    const off = await build(false);
    expect(off.recalled.map((e) => e.id)).toContain(old.id);
  });
});
