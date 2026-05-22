import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "./memory-store.js";

/**
 * Memory-v2 phase 5. `MemoryStore.archiveInto` + the
 * `excludeArchived` list option are the storage-side primitives the
 * consolidator and `### memory-index` renderer rely on. Pins:
 *
 *   - `archiveInto` is atomic and idempotent.
 *   - Archived rows survive `recall { id }` but disappear from
 *     `list({ excludeArchived: true })` / `listIndex`.
 *   - The back-pointer is readable via `getConsolidatedInto`.
 */

interface Harness {
  dir: string;
  store: MemoryStore;
  dispose: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-mem-archive-"));
  const store = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  return {
    dir,
    store,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("MemoryStore archive (phase 5)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("archiveInto marks rows with consolidated_into atomically", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    const b = h.store.store({ content: "note B", source: "agent" });
    const c = h.store.store({ content: "note C", source: "agent" });
    const changes = h.store.archiveInto([a.id, b.id, c.id], 42, 5_000);
    expect(changes).toBe(3);
    expect(h.store.getConsolidatedInto(a.id)).toBe(42);
    expect(h.store.getConsolidatedInto(b.id)).toBe(42);
    expect(h.store.getConsolidatedInto(c.id)).toBe(42);
  });

  it("archiveInto is idempotent — second call counts zero changes", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    expect(h.store.archiveInto([a.id], 11)).toBe(1);
    expect(h.store.archiveInto([a.id], 11)).toBe(0);
  });

  it("archived rows still readable via get(id) (cross-phase invariant 9)", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    h.store.archiveInto([a.id], 7);
    expect(h.store.get(a.id)?.content).toBe("note A");
  });

  it("list({ excludeArchived: true }) filters out archived rows", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    const b = h.store.store({ content: "note B", source: "agent" });
    h.store.archiveInto([a.id], 9);
    const all = h.store.list({}).map((r) => r.id);
    const visible = h.store.list({ excludeArchived: true }).map((r) => r.id);
    expect(all.sort()).toEqual([a.id, b.id].sort());
    expect(visible).toEqual([b.id]);
  });

  it("listIndex picks up the archive filter via excludeArchived", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    const b = h.store.store({ content: "note B", source: "agent" });
    h.store.archiveInto([a.id], 9);
    expect(
      h.store
        .listIndex({ excludeArchived: true })
        .map((r) => r.id),
    ).toEqual([b.id]);
  });

  it("archiveInto with empty parentIds is a no-op", () => {
    expect(h.store.archiveInto([], 1)).toBe(0);
  });

  it("getConsolidatedInto returns null for unarchived row", () => {
    const a = h.store.store({ content: "note A", source: "agent" });
    expect(h.store.getConsolidatedInto(a.id)).toBeNull();
  });
});
