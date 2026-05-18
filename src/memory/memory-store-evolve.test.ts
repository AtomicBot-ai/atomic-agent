import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore, MemoryValidationError } from "./memory-store.js";

/**
 * Memory-v2 phase 3. Direct tests on `MemoryStore.evolveTags` + the
 * `consolidating_at` lease helpers. The runner-level tests live in
 * `src/memory/evolution/neighbor-evolver.test.ts`.
 */
describe("MemoryStore.evolveTags", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-evolve-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 100,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("merges new tags into the existing set", () => {
    const seeded = store.store({ content: "x", tags: ["a", "b"] });
    const r = store.evolveTags(seeded.id, ["c", "d"], { leaseMs: 0 });
    expect(r.outcome).toBe("applied");
    if (r.outcome !== "applied") throw new Error();
    expect(r.tags).toEqual(["a", "b", "c", "d"]);
    expect(r.added).toEqual(["c", "d"]);
  });

  it("returns skipped_no_change when every tag already exists", () => {
    const seeded = store.store({ content: "x", tags: ["a", "b"] });
    const r = store.evolveTags(seeded.id, ["a"], { leaseMs: 0 });
    expect(r.outcome).toBe("skipped_no_change");
  });

  it("preserves content byte-stable across N evolves (invariant 5)", () => {
    const original = "playwright primer content";
    const seeded = store.store({ content: original });
    for (let i = 0; i < 10; i += 1) {
      store.evolveTags(seeded.id, [`tag_${i}`], { leaseMs: 0 });
    }
    expect(store.get(seeded.id)?.content).toBe(original);
  });

  it("returns missing for an unknown id", () => {
    const r = store.evolveTags(99999, ["x"], { leaseMs: 0 });
    expect(r.outcome).toBe("missing");
  });

  it("rejects an empty add-tags list", () => {
    const seeded = store.store({ content: "x" });
    expect(() =>
      store.evolveTags(seeded.id, [], { leaseMs: 0 }),
    ).toThrow(MemoryValidationError);
  });

  it("respects the lease window (skip when held)", () => {
    const seeded = store.store({ content: "x", tags: ["a"] });
    expect(
      store.acquireConsolidationLease(seeded.id, 60_000, 1_000),
    ).toBe(true);
    const r = store.evolveTags(seeded.id, ["b"], {
      leaseMs: 60_000,
      now: 30_000,
    });
    expect(r.outcome).toBe("skipped_lease_held");
    expect(store.get(seeded.id)?.tags).toEqual(["a"]);
  });

  it("ignores an expired lease and applies the evolve", () => {
    const seeded = store.store({ content: "x", tags: ["a"] });
    store.acquireConsolidationLease(seeded.id, 60_000, 1_000);
    const r = store.evolveTags(seeded.id, ["b"], {
      leaseMs: 60_000,
      now: 1_000 + 60_001,
    });
    expect(r.outcome).toBe("applied");
  });

  it("acquireConsolidationLease is single-writer: second concurrent acquire fails", () => {
    const seeded = store.store({ content: "x" });
    expect(
      store.acquireConsolidationLease(seeded.id, 60_000, 100),
    ).toBe(true);
    expect(
      store.acquireConsolidationLease(seeded.id, 60_000, 200),
    ).toBe(false);
  });

  it("releaseConsolidationLease lets a new acquire succeed", () => {
    const seeded = store.store({ content: "x" });
    store.acquireConsolidationLease(seeded.id, 60_000, 100);
    expect(store.releaseConsolidationLease(seeded.id)).toBe(true);
    expect(
      store.acquireConsolidationLease(seeded.id, 60_000, 200),
    ).toBe(true);
  });

  it("bumps updated_at on a successful evolve, leaves it alone on no_change", () => {
    const seeded = store.store({ content: "x", tags: ["a"] });
    const before = store.get(seeded.id)?.updatedAt;
    const later = (before ?? 0) + 10_000;
    store.evolveTags(seeded.id, ["b"], { leaseMs: 0, now: later });
    expect(store.get(seeded.id)?.updatedAt).toBe(later);

    const noChangeNow = later + 5_000;
    store.evolveTags(seeded.id, ["a"], { leaseMs: 0, now: noChangeNow });
    expect(store.get(seeded.id)?.updatedAt).toBe(later);
  });

  it("does not write past MEMORY_MAX_TAGS — existing tags win on overflow", () => {
    // Seed with the max (16); evolve attempts to add one more.
    const seedTags = Array.from({ length: 16 }, (_, i) => `seed_${i}`);
    const seeded = store.store({ content: "x", tags: seedTags });
    const r = store.evolveTags(seeded.id, ["overflow"], { leaseMs: 0 });
    expect(r.outcome).toBe("skipped_no_change");
    expect(store.get(seeded.id)?.tags).toEqual(seedTags);
  });
});
