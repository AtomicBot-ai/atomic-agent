import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, MEMORY_LIST_MAX_LIMIT } from "./memory-store.js";

describe("MemoryStore.hasContent", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-has-content-"));
    store = new MemoryStore({
      dbFile: join(dir, "memory.sqlite"),
      maxEntries: MEMORY_LIST_MAX_LIMIT + 50,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the exact trimmed content, past the list cap", () => {
    store.store({ content: "the oldest note" }, 1);
    for (let i = 0; i < MEMORY_LIST_MAX_LIMIT + 10; i += 1) {
      store.store({ content: `filler ${i}` }, 10 + i);
    }

    expect(store.hasContent("the oldest note")).toBe(true);
    expect(store.hasContent("  the oldest note\n")).toBe(true);
    expect(store.hasContent("the oldest")).toBe(false);
  });
});
