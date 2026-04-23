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
 */
export class SlotManager {
  private readonly assignments = new Map<string, SlotAssignment>();
  private readonly slotCount: number;
  private slotPool: number[];
  private nextRoundRobin = 0;
  private reservedReflectionSlot: number | null = null;

  constructor(slotCount = 4) {
    if (slotCount <= 0) {
      throw new Error("slotCount must be positive");
    }
    this.slotCount = slotCount;
    this.slotPool = Array.from({ length: slotCount }, (_, i) => i);
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
