import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMemoryContextProvider } from "./memory-context-provider.js";
import { MemoryStore } from "./memory-store.js";

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

  function input(userMessage: string | null = null) {
    return {
      sessionId: "s1",
      userMessage,
      signal: new AbortController().signal,
    };
  }

  it("returns empty arrays when both channels are disabled", () => {
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: false, k: 3 },
      index: { enabled: false, limit: 20, previewChars: 40 },
    });
    const ctx = provider.buildMemoryContext(input("lisbon trip")) as {
      recalled: unknown[];
      index: unknown[];
    };
    expect(ctx.recalled).toEqual([]);
    expect(ctx.index).toEqual([]);
  });

  it("runs BM25 recall against the user message", () => {
    store.store({ content: "trip to lisbon in october" });
    store.store({ content: "unrelated grocery list" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
    });
    const ctx = provider.buildMemoryContext(
      input("planning lisbon trip"),
    ) as unknown as {
      recalled: Array<{ content: string }>;
      index: unknown[];
    };
    expect(ctx.recalled.length).toBeGreaterThan(0);
    expect(ctx.recalled[0]!.content).toContain("lisbon");
  });

  it("skips recall when userMessage is empty or null", () => {
    store.store({ content: "durable fact" });
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: false, limit: 0, previewChars: 40 },
    });
    expect(provider.buildMemoryContext(input(null))).toEqual({
      recalled: [],
      index: [],
    });
    expect(provider.buildMemoryContext(input("   "))).toEqual({
      recalled: [],
      index: [],
    });
  });

  it("populates the memory-index with recent entries", () => {
    store.store({ content: "oldest", tags: ["old"] }, 1);
    store.store({ content: "middle" }, 2);
    store.store({ content: "newest" }, 3);
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: false, k: 0 },
      index: { enabled: true, limit: 10, previewChars: 40 },
    });
    const ctx = provider.buildMemoryContext(input(null)) as unknown as {
      recalled: unknown[];
      index: Array<{ preview: string }>;
    };
    expect(ctx.index.map((e) => e.preview)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("deduplicates: entries in recalled are excluded from index", () => {
    const hit = store.store({ content: "lisbon vacation plan" }, 10);
    store.store({ content: "buy milk" }, 20);
    store.store({ content: "call mom" }, 30);
    const provider = createDefaultMemoryContextProvider({
      store,
      recall: { enabled: true, k: 5 },
      index: { enabled: true, limit: 10, previewChars: 40 },
    });
    const ctx = provider.buildMemoryContext(input("lisbon")) as unknown as {
      recalled: Array<{ id: number }>;
      index: Array<{ id: number }>;
    };
    expect(ctx.recalled.some((e) => e.id === hit.id)).toBe(true);
    expect(ctx.index.every((e) => e.id !== hit.id)).toBe(true);
  });
});
