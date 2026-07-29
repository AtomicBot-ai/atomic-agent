import { describe, it, expect } from "vitest";
import { SlotManager, hashPrefix, DEFAULT_SLOT_COUNT } from "./slot-manager.js";

describe("SlotManager", () => {
  // Guessing high is not free: llama.cpp wraps an out-of-range `id_slot`
  // (`id_slot % n_slots`) into another session's slot instead of erroring,
  // so an oversized pool silently evicts KV cache. Slot 0 is the only id
  // every llama-server is guaranteed to have.
  it("defaults to a single slot so no id can exceed the server's count", () => {
    expect(DEFAULT_SLOT_COUNT).toBe(1);
    const mgr = new SlotManager();
    expect(mgr.getSlotCount()).toBe(1);
    for (let i = 0; i < 10; i++) {
      expect(mgr.acquire(`sess-${i}`, "prefix").slotId).toBe(0);
    }
  });

  describe("resize", () => {
    it("widens the pool to the discovered slot count", () => {
      const mgr = new SlotManager();
      mgr.resize(2);
      expect(mgr.getSlotCount()).toBe(2);
      const ids = ["a", "b", "c"].map((s) => mgr.acquire(s, "prefix").slotId);
      expect(ids).toEqual([0, 1, 0]);
    });

    it("is a no-op when the count is unchanged, preserving affinity", () => {
      const mgr = new SlotManager(2);
      const before = mgr.acquire("sess", "prefix");
      mgr.resize(2);
      const after = mgr.acquire("sess", "prefix");
      expect(after.slotId).toBe(before.slotId);
      expect(after.cacheReused).toBe(true);
    });

    it("drops stale assignments whose slot may no longer exist", () => {
      const mgr = new SlotManager(4);
      const before = mgr.acquire("sess", "prefix");
      mgr.resize(2);
      const after = mgr.acquire("sess", "prefix");
      expect(after.cacheReused).toBe(false);
      expect(after.slotId).toBeLessThan(2);
      void before;
    });

    it("never hands out an id at or above the new slot count", () => {
      const mgr = new SlotManager(8);
      mgr.reserveReflectionSlot();
      mgr.resize(2);
      for (let i = 0; i < 20; i++) {
        expect(mgr.acquire(`sess-${i}`, "prefix").slotId).toBeLessThan(2);
      }
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

    it("keeps an in-range reflection reservation off the acquire pool", () => {
      const mgr = new SlotManager(4);
      const reserved = mgr.reserveReflectionSlot();
      expect(reserved).toBe(3);
      // Widening keeps slot 3 valid, so the reservation must survive.
      mgr.resize(5);
      expect(mgr.reserveReflectionSlot()).toBe(reserved);
      for (let i = 0; i < 10; i++) {
        expect(mgr.acquire(`sess-${i}`, "prefix").slotId).not.toBe(reserved);
      }
    });

    it("gives the sole slot back to the agent when shrinking to one", () => {
      const mgr = new SlotManager(4);
      mgr.reserveReflectionSlot();
      mgr.resize(1);
      expect(mgr.acquire("sess", "prefix").slotId).toBe(0);
      expect(mgr.reserveReflectionSlot()).toBeNull();
    });

    it("rejects a non-positive slot count", () => {
      expect(() => new SlotManager(2).resize(0)).toThrow(/must be positive/);
    });
  });

  it("returns the same slot for an unchanged prefix within a session", () => {
    const mgr = new SlotManager(4);
    const a = mgr.acquire("sess-1", "stable prefix v1");
    const b = mgr.acquire("sess-1", "stable prefix v1");
    expect(b.slotId).toBe(a.slotId);
    expect(b.prefixHash).toBe(a.prefixHash);
    expect(a.cacheReused).toBe(false);
    expect(b.cacheReused).toBe(true);
  });

  it("rotates the slot when the prefix changes", () => {
    const mgr = new SlotManager(4);
    const first = mgr.acquire("sess-1", "prefix A");
    const second = mgr.acquire("sess-1", "prefix B");
    expect(second.prefixHash).not.toBe(first.prefixHash);
  });

  it("distributes slots round-robin across sessions", () => {
    const mgr = new SlotManager(3);
    const s1 = mgr.acquire("a", "prefix");
    const s2 = mgr.acquire("b", "prefix");
    const s3 = mgr.acquire("c", "prefix");
    const s4 = mgr.acquire("d", "prefix");
    expect([s1.slotId, s2.slotId, s3.slotId, s4.slotId]).toEqual([0, 1, 2, 0]);
  });

  it("release() frees the session's mapping", () => {
    const mgr = new SlotManager(2);
    const a = mgr.acquire("s", "p");
    mgr.release("s");
    const b = mgr.acquire("s", "p");
    expect(b.firstSeenAt).toBeGreaterThanOrEqual(a.firstSeenAt);
  });

  describe("reserveReflectionSlot", () => {
    it("returns null when only one slot is configured", () => {
      const mgr = new SlotManager(1);
      expect(mgr.reserveReflectionSlot()).toBeNull();
    });

    it("returns a slot index that will never be handed out by acquire()", () => {
      const mgr = new SlotManager(3);
      const reflectionSlot = mgr.reserveReflectionSlot();
      expect(reflectionSlot).not.toBeNull();
      // Drain several acquire() calls — none of them should return the
      // reserved slot.
      for (let i = 0; i < 20; i++) {
        const assignment = mgr.acquire(`sess-${i}`, "prefix");
        expect(assignment.slotId).not.toBe(reflectionSlot);
      }
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
});

describe("hashPrefix", () => {
  it("is deterministic for the same input", () => {
    expect(hashPrefix("abc")).toBe(hashPrefix("abc"));
  });
  it("differs for different inputs", () => {
    expect(hashPrefix("abc")).not.toBe(hashPrefix("abd"));
  });
});
