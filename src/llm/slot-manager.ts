import { createHash } from "node:crypto";
import { getConfig } from "../config/index.js";

export interface SlotAssignment {
  /**
   * The llama-server slot this session's prompt lives in, or `-1` while
   * the session has none yet (`pending`). A `-1` sent WITH
   * `cache_prompt: true` asks llama-server to pick the slot itself — by
   * longest-common-prefix similarity first, least-recently-used second —
   * which is how a resumed session finds the slot that still holds its
   * prompt after a TUI restart. The server names the slot it chose in
   * the completion (`id_slot`), and the caller pins it with `pin()`.
   */
  slotId: number;
  prefixHash: string;
  firstSeenAt: number;
  /**
   * True when the caller reused an existing (sessionId, prefix) assignment,
   * which on the llama-server side implies the KV-cache can be reused.
   */
  cacheReused: boolean;
  /**
   * No slot has been pinned for this session yet: send `id_slot: -1`
   * with `cache_prompt: true` and pin whatever the server answers with.
   * A pending assignment is not stored — a request that fails before the
   * server names a slot leaves the next attempt free to ask again.
   */
  pending: boolean;
}

/**
 * A slot id, or a thunk that resolves one at call time. Side-call
 * runners (reflection, link generation, voting, distillation, the query
 * rewriter) are built at boot, when a managed daemon's slot count is not
 * known yet; a thunk lets them reserve the reflection slot on their
 * first call instead of capturing `-1` forever.
 */
export type SlotIdSource = number | (() => number);

export function resolveSlotId(source: SlotIdSource): number {
  return typeof source === "function" ? source() : source;
}

/**
 * Maps a session to a slot on the llama-server. Reusing the same
 * `id_slot` with `cache_prompt=true` is what makes the KV cache hit on
 * llama.cpp.
 *
 * **Who picks the slot.** Not this class. A session's first request (and
 * its first after `resize()`) carries `id_slot: -1` and `cache_prompt:
 * true`, so llama-server selects the slot by prefix similarity and falls
 * back to the least-recently-used one — never worse than a cold slot,
 * and warm after a restart when the server still holds the prompt. The
 * step executor reads the chosen `id_slot` off the completion and pins
 * it here; from then on every request of the session, retries included,
 * names that slot. A stable-prefix change does NOT move the session: the
 * server re-evaluates from the point of divergence in the same slot,
 * which is cheaper than a cold slot and keeps the conversation's cache
 * where it is.
 *
 * We keep the mapping purely in-process; the server itself owns the
 * cache. On restart every session simply starts pending, and the `-1`
 * request finds its old slot when the server still has it.
 *
 * **Concurrency contract (single-active-turn-per-session).** `acquire`
 * and `pin` do no internal locking; they rely on the runtime invariant
 * that at most one `runTurn` is in flight per `sessionId`. That
 * invariant is enforced by `TurnController` in
 * [src/runtime/turn-controller.ts] — every entry point (CLI, TUI, HTTP,
 * sidecar, scheduler) funnels through it. Concurrent calls from
 * different sessions are safe because each session has its own entry in
 * the map; concurrent calls for the *same* session are a
 * controller-contract violation. Do not call `acquire` outside an
 * `AgentLoop.runTurn` frame.
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
  private reservedReflectionSlot: number | null = null;
  /** Whether a `/props` answer has ever sized the pool — see `observedPoolSize`. */
  private observed = false;

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
   * Slots sessions can run on: the configured count minus the reflection
   * reservation. This — not `getSlotCount()` — is how many turns can run
   * against the local server without two of them sharing a slot and
   * evicting each other's KV cache; the fusion fan-out sizes its
   * concurrent worker count from it.
   */
  poolSize(): number {
    return this.slotPool.length;
  }

  /**
   * `poolSize()` once the server has been asked, `null` before. The
   * constructor's count is a guess (one slot, or the configured
   * `--parallel`); `resize()` is called from a `/props` answer, and only
   * a number the server itself reported is one the `### fusion` machine
   * facts may state — a guessed slot count is a number the model plans
   * against.
   */
  observedPoolSize(): number | null {
    return this.observed ? this.poolSize() : null;
  }

  /**
   * Re-size the pool to the server's actual slot count, discovered from a
   * later `/props` probe. No-op when the count is unchanged, so the common
   * refresh path costs nothing and never disturbs live cache affinity.
   *
   * On a real change every existing assignment is dropped: a session's
   * slot id may no longer exist, and the server-side KV for it is not
   * where we think it is either way. The next `acquire` comes back
   * pending, so the session's next request lets the server pick by
   * prefix similarity — which finds the old slot when it still exists.
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
    // An unchanged count is still an observation: the server confirmed
    // the number the pool was built with.
    this.observed = true;
    if (slotCount === this.slotCount) return;
    const reserved =
      this.reservedReflectionSlot !== null &&
      this.reservedReflectionSlot < slotCount
        ? this.reservedReflectionSlot
        : null;
    this.slotCount = slotCount;
    this.assignments.clear();
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

  /**
   * The assignment a request should carry. A pinned session gets its slot
   * back whatever the prefix did — `cacheReused` says whether the prefix
   * is the one the slot was pinned under, and the stored hash follows the
   * prefix so the next step reports reuse again. A session without a pin
   * gets a pending assignment (`slotId: -1`); see `pin()`.
   */
  acquire(sessionId: string, stablePrefix: string): SlotAssignment {
    const prefixHash = hashPrefix(stablePrefix);
    const existing = this.assignments.get(sessionId);
    if (existing) {
      const cacheReused = existing.prefixHash === prefixHash;
      if (!cacheReused) {
        this.assignments.set(sessionId, { ...existing, prefixHash });
      }
      return { ...existing, prefixHash, cacheReused };
    }
    return {
      slotId: -1,
      prefixHash,
      firstSeenAt: Date.now(),
      cacheReused: false,
      pending: true,
    };
  }

  /**
   * Record the slot llama-server chose for a session's pending request.
   * The server's answer is the truth even when it names the reserved
   * reflection slot or an id above the pool the probe reported — the
   * prompt is in that slot now, and pointing anywhere else would be the
   * cold rebuild this exists to avoid. Negative ids (a server that did
   * not say) leave the session pending.
   */
  pin(sessionId: string, slotId: number, prefixHash: string): void {
    if (!Number.isInteger(slotId) || slotId < 0) return;
    const existing = this.assignments.get(sessionId);
    if (existing && existing.slotId === slotId) {
      if (existing.prefixHash !== prefixHash) {
        this.assignments.set(sessionId, { ...existing, prefixHash });
      }
      return;
    }
    this.assignments.set(sessionId, {
      slotId,
      prefixHash,
      firstSeenAt: Date.now(),
      cacheReused: false,
      pending: false,
    });
  }

  /** The pinned slot for a session, or `null` while it has none. */
  pinnedSlot(sessionId: string): number | null {
    return this.assignments.get(sessionId)?.slotId ?? null;
  }

  release(sessionId: string): void {
    this.assignments.delete(sessionId);
  }

  reset(): void {
    this.assignments.clear();
    this.slotPool = Array.from({ length: this.slotCount }, (_, i) => i);
    this.reservedReflectionSlot = null;
  }

  /**
   * Carve out a slot for the async reflection runner and the other side
   * calls (link generation, voting, distillation, the query rewriter).
   * The reserved slot leaves the pool `poolSize()` reports, so the fusion
   * fan-out never plans a worker onto it. It prefers a slot no session is
   * pinned to, so reserving late — after the pool was widened by the
   * first `/props` — does not take a slot a session's prompt is in.
   *
   * Returns `null` when only one slot is available: reserving the sole
   * slot would starve the agent loop, so the caller should fall back to
   * `slotId: -1` (no cache affinity) for the side call in that case —
   * `sideCallSlotId()` does exactly that. Idempotent — subsequent calls
   * return the slot reserved on the first call.
   */
  reserveReflectionSlot(): number | null {
    if (this.reservedReflectionSlot !== null) {
      return this.reservedReflectionSlot;
    }
    if (this.slotPool.length <= 1) {
      return null;
    }
    const pinned = new Set(
      [...this.assignments.values()].map((assignment) => assignment.slotId),
    );
    let index = this.slotPool.length - 1;
    for (let i = this.slotPool.length - 1; i >= 0; i -= 1) {
      if (!pinned.has(this.slotPool[i]!)) {
        index = i;
        break;
      }
    }
    const [reserved] = this.slotPool.splice(index, 1);
    this.reservedReflectionSlot = reserved!;
    return reserved!;
  }

  /**
   * Where a side call runs: the reserved reflection slot when the pool
   * has room for one, else `-1`. Resolved at call time so a runner built
   * before the managed daemon's `/props` widened the pool still lands on
   * the reservation once there is one.
   */
  sideCallSlotId(): number {
    return this.reserveReflectionSlot() ?? -1;
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
