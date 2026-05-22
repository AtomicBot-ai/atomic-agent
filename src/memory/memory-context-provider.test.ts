import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMemoryContextProvider } from "./memory-context-provider.js";
import { MemoryStore } from "./memory-store.js";
import { LinkStore } from "./links/link-store.js";

describe("createDefaultMemoryContextProvider", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-memctx-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 100,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function input(
    userMessage: string | null = null,
    toolResultSummaries: readonly string[] = [],
  ) {
    return {
      sessionId: "s1",
      userMessage,
      toolResultSummaries,
      signal: new AbortController().signal,
    };
  }

  it("returns empty arrays when both channels are disabled", async () => {
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: false, k: 3 },
      index: { enabled: false, limit: 20, previewChars: 40 },
    });
    const ctx = (await provider.buildMemoryContext(input("lisbon trip"))) as {
      recalled: unknown[];
      index: unknown[];
    };
    expect(ctx.recalled).toEqual([]);
    expect(ctx.index).toEqual([]);
  });

  it("runs BM25 recall against the user message", async () => {
    store.store({ content: "trip to lisbon in october" });
    store.store({ content: "unrelated grocery list" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
    });
    const ctx = (await provider.buildMemoryContext(
      input("planning lisbon trip"),
    )) as unknown as {
      recalled: Array<{ content: string }>;
      index: unknown[];
    };
    expect(ctx.recalled.length).toBeGreaterThan(0);
    expect(ctx.recalled[0]!.content).toContain("lisbon");
  });

  it("skips recall when userMessage is empty or null", async () => {
    store.store({ content: "durable fact" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
    });
    expect(await provider.buildMemoryContext(input(null))).toEqual({
      recalled: [],
      index: [],
    });
    expect(await provider.buildMemoryContext(input("   "))).toEqual({
      recalled: [],
      index: [],
    });
  });

  it("recalls against recent tool-result summaries between agent steps", async () => {
    store.store({ content: "cart total bug lives in src/cart.ts" });
    store.store({ content: "unrelated grocery list" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
    });
    const ctx = (await provider.buildMemoryContext(
      input("fix the failing test", ["os.fs.read: opened src/cart.ts"]),
    )) as unknown as {
      recalled: Array<{ content: string }>;
      index: unknown[];
    };
    expect(ctx.recalled.map((entry) => entry.content)).toContain(
      "cart total bug lives in src/cart.ts",
    );
  });

  it("populates the memory-index with recent entries", async () => {
    store.store({ content: "oldest", tags: ["old"] }, 1);
    store.store({ content: "middle" }, 2);
    store.store({ content: "newest" }, 3);
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: false, k: 0 },
      index: { enabled: true, limit: 10, previewChars: 40 },
    });
    const ctx = (await provider.buildMemoryContext(
      input(null),
    )) as unknown as {
      recalled: unknown[];
      index: Array<{ preview: string }>;
    };
    expect(ctx.index.map((e) => e.preview)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("deduplicates: entries in recalled are excluded from index", async () => {
    const hit = store.store({ content: "lisbon vacation plan" }, 10);
    store.store({ content: "buy milk" }, 20);
    store.store({ content: "call mom" }, 30);
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: true, limit: 10, previewChars: 40 },
    });
    const ctx = (await provider.buildMemoryContext(
      input("lisbon"),
    )) as unknown as {
      recalled: Array<{ id: number }>;
      index: Array<{ id: number }>;
    };
    expect(ctx.recalled.some((e) => e.id === hit.id)).toBe(true);
    expect(ctx.index.every((e) => e.id !== hit.id)).toBe(true);
  });

  it("phase 2: expands recalled via link graph when enabled (multi-hop demo)", async () => {
    // Seed three notes — only A matches the BM25 query; B and C are
    // linked outward so the graph expansion should surface them.
    const a = store.store({ content: "lisbon trip october" });
    const b = store.store({ content: "ticket from porto to faro" });
    const c = store.store({ content: "hostel reservation in sintra" });
    const linkStore = new LinkStore({
      db: store.getDatabaseHandleForEmbeddings(),
    });
    linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    linkStore.add({ fromId: b.id, toId: c.id, kind: "REFERENCES" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
      links: {
        enabled: true,
        store: linkStore,
        depth: 2,
        maxExpanded: 10,
      },
    });
    const ctx = (await provider.buildMemoryContext(
      input("lisbon"),
    )) as unknown as { recalled: Array<{ id: number }> };
    const ids = ctx.recalled.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
  });

  it("phase 2: stays byte-identical when link expansion is disabled", async () => {
    const a = store.store({ content: "lisbon trip" });
    const b = store.store({ content: "porto faro ticket" });
    const linkStore = new LinkStore({
      db: store.getDatabaseHandleForEmbeddings(),
    });
    linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
      // links not provided ⇒ no expansion
    });
    const ctx = (await provider.buildMemoryContext(
      input("lisbon"),
    )) as unknown as { recalled: Array<{ id: number }> };
    const ids = ctx.recalled.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
