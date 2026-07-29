import { createHash } from "node:crypto";
import { getConfig } from "../config/index.js";

export interface SlotAssignment {
  slotId: number;
  prefixHash: string;
  firstSeenAt: number;
  /**
   * True when the caller reused an existing (sessionId, prefix) assignment,
   * which on the llama-server side implies the KV-cache can be reused.
   */
  cacheReused: boolean;
}

/**
 * Maps a (session, stable-prefix) pair to a slot_id on the external
 * llama-server. Reusing the same slot_id with cache_prompt=true is what
 * makes KV-cache hit on llama.cpp — if the prefix changes we rotate.
 *
 * We keep the mapping purely in-process; the server itself owns the cache.
 * On restart every session simply starts cold — that is acceptable because
 * prefix recomputation is a single LLM pass at sub-second latency.
 *
 * **Concurrency contract (single-active-turn-per-session).** `acquire`
 * does no internal locking; it relies on the runtime invariant that at
 * most one `runTurn` is in flight per `sessionId`. That invariant is
 * enforced by `TurnController` in [src/runtime/turn-controller.ts] —
 * every entry point (CLI, TUI, HTTP, sidecar, scheduler) funnels
 * through it. Concurrent `acquire(sessionId, …)` from different
 * sessions is safe because each session has its own assignment slot
 * in the map and the round-robin pointer is integer-mutating;
 * concurrent `acquire(sessionId, …)` for the *same* session is a
 * controller-contract violation and would race the prefix swap. Do
 * not call `acquire` outside an `AgentLoop.runTurn` frame.
 */
/**
 * Slot count used when the `/props` probe has not answered yet. Every
 * llama-server has slot 0; anything above that is a guess. The previous
 * default of 4 was one such guess, and it outlived the probe in managed
 * mode (which always defers the boot health check), so sessions were
 * handed slot ids 1-3 against a `--parallel 2` daemon. llama.cpp wraps
 * out-of-range ids (`id_slot % n_slots`), so nothing errored — the ids
 * silently collided instead, evicting the KV cache and forcing a full
 * prompt reprocess on every rotation. One slot is always correct;
 * `resize()` widens the pool once the real count is known.
 */
export const DEFAULT_SLOT_COUNT = 1;

export class SlotManager {
  private readonly assignments = new Map<string, SlotAssignment>();
  private slotCount: number;
  private slotPool: number[];
  private nextRoundRobin = 0;
  private reservedReflectionSlot: number | null = null;

  constructor(slotCount = DEFAULT_SLOT_COUNT) {
    if (slotCount <= 0) {
      throw new Error("slotCount must be positive");
    }
    this.slotCount = slotCount;
    this.slotPool = Array.from({ length: slotCount }, (_, i) => i);
  }

  /** Slot count the pool is currently sized for. */
  getSlotCount(): number {
    return this.slotCount;
  }

  /**
   * Re-size the pool to the server's actual slot count, discovered from a
   * later `/props` probe. No-op when the count is unchanged, so the common
   * refresh path costs nothing and never disturbs live cache affinity.
   *
   * On a real change every existing assignment is dropped: a session's
   * slot id may no longer exist, and the server-side KV for it is not
   * where we think it is either way. The next `acquire` re-assigns with
   * `cacheReused: false`, which is honest — one cold prefix rebuild beats
   * silently pointing at a stranger's cache.
   *
   * A reflection reservation that is still in range is preserved; one that
   * fell outside is released back so `reserveReflectionSlot()` can re-take
   * a valid slot. Call this between turns — `acquire` has no locking and
   * the single-active-turn-per-session invariant is what keeps it safe.
   */
  resize(slotCount: number): void {
    if (slotCount <= 0) {
      throw new Error("slotCount must be positive");
    }
    if (slotCount === this.slotCount) return;
    const reserved =
      this.reservedReflectionSlot !== null &&
      this.reservedReflectionSlot < slotCount
        ? this.reservedReflectionSlot
        : null;
    this.slotCount = slotCount;
    this.assignments.clear();
    this.nextRoundRobin = 0;
    this.reservedReflectionSlot = reserved;
    this.slotPool = Array.from({ length: slotCount }, (_, i) => i).filter(
      (id) => id !== reserved,
    );
    // Reserving the only slot would starve the agent loop; hand it back.
    if (this.slotPool.length === 0) {
      this.reservedReflectionSlot = null;
      this.slotPool = [0];
    }
  }

  acquire(sessionId: string, stablePrefix: string): SlotAssignment {
    const prefixHash = hashPrefix(stablePrefix);
    const existing = this.assignments.get(sessionId);
    if (existing && existing.prefixHash === prefixHash) {
      return { ...existing, cacheReused: true };
    }
    const slotId = this.pickSlot();
    const assignment: SlotAssignment = {
      slotId,
      prefixHash,
      firstSeenAt: Date.now(),
      cacheReused: false,
    };
    this.assignments.set(sessionId, assignment);
    return assignment;
  }

  release(sessionId: string): void {
    this.assignments.delete(sessionId);
  }

  reset(): void {
    this.assignments.clear();
    this.nextRoundRobin = 0;
    this.slotPool = Array.from({ length: this.slotCount }, (_, i) => i);
    this.reservedReflectionSlot = null;
  }

  /**
   * Carve out a slot for the async reflection runner. The reserved slot
   * is removed from the round-robin pool used by `acquire()`, so it
   * will never be handed to a session — guaranteeing the main agent's
   * KV cache is never evicted by a reflection call.
   *
   * Returns `null` when only one slot is configured: reserving the sole
   * slot would starve the agent loop, so the caller should fall back to
   * `slotId: -1` (no cache affinity) for reflection in that case.
   * Idempotent — subsequent calls return the slot reserved on the first
   * call.
   */
  reserveReflectionSlot(): number | null {
    if (this.reservedReflectionSlot !== null) {
      return this.reservedReflectionSlot;
    }
    if (this.slotPool.length <= 1) {
      return null;
    }
    const reserved = this.slotPool.pop()!;
    this.reservedReflectionSlot = reserved;
    return reserved;
  }

  private pickSlot(): number {
    const slot = this.slotPool[this.nextRoundRobin % this.slotPool.length]!;
    this.nextRoundRobin += 1;
    return slot;
  }
}

export function hashPrefix(input: string): string {
  const config = getConfig();
  return createHash("sha256")
    .update(config.agent.stablePrefixHashSalt)
    .update("\n")
    .update(input)
    .digest("hex");
}
