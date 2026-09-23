import { describe, it, expect } from "vitest";
import {
  SlotManager,
  hashPrefix,
  resolveSlotId,
  DEFAULT_SLOT_COUNT,
} from "./slot-manager.js";

describe("SlotManager", () => {
  // Guessing high is not free: llama.cpp wraps an out-of-range `id_slot`
  // (`id_slot % n_slots`) into another session's slot instead of erroring,
  // so an oversized pool silently evicts KV cache. Slot 0 is the only id
  // every llama-server is guaranteed to have.
  it("defaults to a single slot so no id can exceed the server's count", () => {
    expect(DEFAULT_SLOT_COUNT).toBe(1);
    const mgr = new SlotManager();
    expect(mgr.getSlotCount()).toBe(1);
    expect(mgr.poolSize()).toBe(1);
  });

  describe("a session's first request", () => {
    it("is pending: id_slot -1, so llama-server picks by prefix similarity", () => {
      const mgr = new SlotManager(4);
      const first = mgr.acquire("sess", "prefix");
      expect(first.slotId).toBe(-1);
      expect(first.pending).toBe(true);
      expect(first.cacheReused).toBe(false);
      expect(first.prefixHash).toBe(hashPrefix("prefix"));
      expect(mgr.pinnedSlot("sess")).toBeNull();
    });

    it("stays pending until the server names a slot — a failed request asks again", () => {
      const mgr = new SlotManager(4);
      mgr.acquire("sess", "prefix");
      const again = mgr.acquire("sess", "prefix");
      expect(again.pending).toBe(true);
      expect(again.slotId).toBe(-1);
    });

    it("pins the slot the server answered with", () => {
      const mgr = new SlotManager(4);
      const first = mgr.acquire("sess", "prefix");
      mgr.pin("sess", 2, first.prefixHash);
      const next = mgr.acquire("sess", "prefix");
      expect(next.slotId).toBe(2);
      expect(next.pending).toBe(false);
      expect(next.cacheReused).toBe(true);
      expect(mgr.pinnedSlot("sess")).toBe(2);
    });

    it("ignores a server that did not name a slot", () => {
      const mgr = new SlotManager(4);
      const first = mgr.acquire("sess", "prefix");
      mgr.pin("sess", -1, first.prefixHash);
      expect(mgr.acquire("sess", "prefix").pending).toBe(true);
    });

    it("pins the server's answer even outside the probed pool", () => {
      // The pool is 1 until the first `/props`; the server may still
      // answer with slot 3, and that is where the prompt is.
      const mgr = new SlotManager(1);
      mgr.pin("sess", 3, hashPrefix("prefix"));
      expect(mgr.acquire("sess", "prefix").slotId).toBe(3);
    });
  });

  it("reports the pool as observed only after a /props answer sized it (F21)", () => {
    const mgr = new SlotManager(2);
    expect(mgr.observedPoolSize()).toBeNull();
    mgr.resize(2);
    expect(mgr.observedPoolSize()).toBe(2);
    mgr.resize(5);
    expect(mgr.observedPoolSize()).toBe(mgr.poolSize());
  });

  describe("resize", () => {
    it("widens the pool to the discovered slot count", () => {
      const mgr = new SlotManager();
      mgr.resize(2);
      expect(mgr.getSlotCount()).toBe(2);
      expect(mgr.poolSize()).toBe(2);
    });

    it("is a no-op when the count is unchanged, preserving affinity", () => {
      const mgr = new SlotManager(2);
      mgr.pin("sess", 1, hashPrefix("prefix"));
      mgr.resize(2);
      const after = mgr.acquire("sess", "prefix");
      expect(after.slotId).toBe(1);
      expect(after.cacheReused).toBe(true);
    });

    it("drops stale assignments so the next request lets the server pick again", () => {
      const mgr = new SlotManager(4);
      mgr.pin("sess", 3, hashPrefix("prefix"));
      mgr.resize(2);
      const after = mgr.acquire("sess", "prefix");
      expect(after.pending).toBe(true);
      expect(after.slotId).toBe(-1);
      expect(after.cacheReused).toBe(false);
    });

    it("releases a reflection reservation that fell out of range", () => {
      const mgr = new SlotManager(4);
      expect(mgr.reserveReflectionSlot()).toBe(3);
      mgr.resize(2);
      // 3 no longer exists, so the reservation must be re-taken in range.
      const reserved = mgr.reserveReflectionSlot();
      expect(reserved).not.toBeNull();
      expect(reserved).toBeLessThan(2);
    });

    it("keeps an in-range reflection reservation off the pool", () => {
      const mgr = new SlotManager(4);
      const reserved = mgr.reserveReflectionSlot();
      expect(reserved).toBe(3);
      // Widening keeps slot 3 valid, so the reservation must survive.
      mgr.resize(5);
      expect(mgr.reserveReflectionSlot()).toBe(reserved);
      expect(mgr.poolSize()).toBe(4);
    });

    it("gives the sole slot back to the agent when shrinking to one", () => {
      const mgr = new SlotManager(4);
      mgr.reserveReflectionSlot();
      mgr.resize(1);
      expect(mgr.poolSize()).toBe(1);
      expect(mgr.reserveReflectionSlot()).toBeNull();
    });

    it("rejects a non-positive slot count", () => {
      expect(() => new SlotManager(2).resize(0)).toThrow(/must be positive/);
    });
  });

  it("returns the same slot for an unchanged prefix within a session", () => {
    const mgr = new SlotManager(4);
    mgr.pin("sess-1", 0, hashPrefix("stable prefix v1"));
    const a = mgr.acquire("sess-1", "stable prefix v1");
    const b = mgr.acquire("sess-1", "stable prefix v1");
    expect(b.slotId).toBe(a.slotId);
    expect(b.prefixHash).toBe(a.prefixHash);
    expect(a.cacheReused).toBe(true);
    expect(b.cacheReused).toBe(true);
  });

  it("keeps the slot when the prefix changes, reporting the cache as not reused once", () => {
    // A prefix change used to rotate the session to another slot — a
    // cold re-read of the whole prompt. The server re-evaluates from the
    // divergence point in the same slot, which is never worse.
    const mgr = new SlotManager(4);
    mgr.pin("sess-1", 2, hashPrefix("prefix A"));
    const changed = mgr.acquire("sess-1", "prefix B");
    expect(changed.slotId).toBe(2);
    expect(changed.pending).toBe(false);
    expect(changed.cacheReused).toBe(false);
    expect(changed.prefixHash).toBe(hashPrefix("prefix B"));
    // The stored hash follows the prefix: the next step is a reuse again.
    const next = mgr.acquire("sess-1", "prefix B");
    expect(next.slotId).toBe(2);
    expect(next.cacheReused).toBe(true);
  });

  it("re-pinning the same slot only refreshes the prefix hash", () => {
    const mgr = new SlotManager(4);
    mgr.pin("sess", 1, hashPrefix("A"));
    const before = mgr.acquire("sess", "A");
    mgr.pin("sess", 1, hashPrefix("B"));
    const after = mgr.acquire("sess", "B");
    expect(after.slotId).toBe(1);
    expect(after.cacheReused).toBe(true);
    expect(after.firstSeenAt).toBe(before.firstSeenAt);
  });

  it("release() frees the session's mapping", () => {
    const mgr = new SlotManager(2);
    mgr.pin("s", 1, hashPrefix("p"));
    mgr.release("s");
    const b = mgr.acquire("s", "p");
    expect(b.pending).toBe(true);
    expect(mgr.pinnedSlot("s")).toBeNull();
  });

  describe("reserveReflectionSlot", () => {
    it("returns null when only one slot is configured", () => {
      const mgr = new SlotManager(1);
      expect(mgr.reserveReflectionSlot()).toBeNull();
    });

    it("takes a slot off the pool the fan-out plans against", () => {
      const mgr = new SlotManager(3);
      const reflectionSlot = mgr.reserveReflectionSlot();
      expect(reflectionSlot).toBe(2);
      expect(mgr.poolSize()).toBe(2);
    });

    it("prefers a slot no session is pinned to when reserving late", () => {
      // Managed mode reserves after the first `/props` widened the pool,
      // by which time a session may already sit in the last slot.
      const mgr = new SlotManager(1);
      mgr.resize(4);
      mgr.pin("sess", 3, hashPrefix("prefix"));
      expect(mgr.reserveReflectionSlot()).toBe(2);
      expect(mgr.acquire("sess", "prefix").slotId).toBe(3);
      expect(mgr.poolSize()).toBe(3);
    });

    it("still reserves when every pool slot is pinned", () => {
      const mgr = new SlotManager(2);
      mgr.pin("a", 0, hashPrefix("p"));
      mgr.pin("b", 1, hashPrefix("p"));
      expect(mgr.reserveReflectionSlot()).toBe(1);
    });

    it("is idempotent across repeated calls", () => {
      const mgr = new SlotManager(4);
      const first = mgr.reserveReflectionSlot();
      const second = mgr.reserveReflectionSlot();
      expect(first).not.toBeNull();
      expect(second).toBe(first);
    });

    it("reset() releases the reserved reflection slot", () => {
      const mgr = new SlotManager(2);
      const reserved = mgr.reserveReflectionSlot();
      expect(reserved).not.toBeNull();
      mgr.reset();
      // After reset() a 2-slot manager should be able to reserve again.
      expect(mgr.reserveReflectionSlot()).not.toBeNull();
    });
  });

  describe("sideCallSlotId", () => {
    it("is -1 while the pool has a single slot", () => {
      const mgr = new SlotManager(1);
      expect(mgr.sideCallSlotId()).toBe(-1);
    });

    it("becomes the reflection slot once the pool has room, resolved at call time", () => {
      // The runners are built at boot with the pool still at one slot;
      // the thunk they hold must find the reservation after `/props`.
      const mgr = new SlotManager(1);
      const source = () => mgr.sideCallSlotId();
      expect(resolveSlotId(source)).toBe(-1);
      mgr.resize(3);
      expect(resolveSlotId(source)).toBe(2);
      expect(resolveSlotId(source)).toBe(2);
      expect(resolveSlotId(1)).toBe(1);
    });
  });
});

describe("hashPrefix", () => {
  it("is deterministic for the same input", () => {
    expect(hashPrefix("abc")).toBe(hashPrefix("abc"));
  });
  it("differs for different inputs", () => {
    expect(hashPrefix("abc")).not.toBe(hashPrefix("abd"));
  });
});

describe("SlotManager.poolSize", () => {
  it("is the configured count until a reflection slot is reserved", () => {
    const mgr = new SlotManager(4);
    expect(mgr.poolSize()).toBe(4);
    expect(mgr.reserveReflectionSlot()).not.toBeNull();
    // `getSlotCount` still says 4; only 3 can be handed to turns.
    expect(mgr.getSlotCount()).toBe(4);
    expect(mgr.poolSize()).toBe(3);
  });

  it("never drops to zero — the sole slot is not reservable", () => {
    const mgr = new SlotManager(1);
    expect(mgr.reserveReflectionSlot()).toBeNull();
    expect(mgr.poolSize()).toBe(1);
  });

  it("tracks resize and reset", () => {
    const mgr = new SlotManager(2);
    mgr.reserveReflectionSlot();
    expect(mgr.poolSize()).toBe(1);
    mgr.resize(4);
    // Reservation (slot 1) survives a widen, so 3 of 4 are usable.
    expect(mgr.poolSize()).toBe(3);
    mgr.reset();
    expect(mgr.poolSize()).toBe(4);
  });
});
