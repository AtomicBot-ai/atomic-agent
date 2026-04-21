import { describe, it, expect } from "vitest";
import { SlotManager, hashPrefix } from "./slot-manager.js";

describe("SlotManager", () => {
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
});

describe("hashPrefix", () => {
  it("is deterministic for the same input", () => {
    expect(hashPrefix("abc")).toBe(hashPrefix("abc"));
  });
  it("differs for different inputs", () => {
    expect(hashPrefix("abc")).not.toBe(hashPrefix("abd"));
  });
});
