import { MAX_PENDING_STEERS } from "../runtime/steering-inbox.js";

/**
 * Parking lot for steering messages a turn handed back on
 * `RunTurnResult.undelivered`.
 *
 * `POST /api/sessions/{id}/steer` answers `200 {steered:true}` as soon
 * as the message is in the inbox, but acceptance is not delivery: a
 * steer that lands during the final inference — or into a turn that is
 * cancelled before its next step — comes back undelivered when the turn
 * closes, and `AgentLoop.flushSteering` empties the inbox as it reads.
 * The steer was its own HTTP exchange whose response was written long
 * before that, so there is nowhere to hand the text back to unless the
 * server keeps it. This store is that "somewhere": it is what makes the
 * HTTP surface hold the same invariant as the sidecar's
 * `steer_undelivered` event — the message you sent always goes
 * somewhere the host can see.
 *
 * Retrieval is deliberately **non-destructive**. `GET` lists, `DELETE`
 * acks by sequence number. A consuming read would lose the message to
 * any retried or prefetched request, which is the exact failure mode
 * this store exists to prevent; and because the ack carries a cursor
 * taken from the listing, a steer parked between the two calls has a
 * higher `seq` and survives the ack.
 *
 * The same reasoning applies to the loss counter. `discarded` is the
 * "N messages are gone" signal, and it is **not** covered by the entry
 * cursor — the discarded messages have no `seq` the host ever saw. It
 * therefore has its own ack ({@link UndeliveredSteerStore.ackDiscarded})
 * and keeps a session's box alive on its own, so acking the entries
 * cannot silently take the loss notice with them.
 *
 * Single-process, in-memory, one instance per HTTP server. Parked
 * messages do not survive a restart — neither does the inbox they came
 * from (`shutdown()` calls `SteeringInbox.clearAll`).
 */
export interface UndeliveredSteer {
  /** Monotonic within one store. The ack cursor for `DELETE`. */
  seq: number;
  text: string;
  /** Epoch ms at which the turn handed the message back. */
  parkedAt: number;
}

/**
 * Per-session cap on **accumulation**, not on one hand-back. The inbox
 * refuses past `MAX_PENDING_STEERS`, so a single turn cannot strand
 * more than that; the cap bites when several turns strand messages and
 * nobody ever acks. Past it the oldest entries go — and `discarded`
 * counts them, so a host that comes back late learns it lost some
 * instead of quietly seeing a short list.
 */
export const MAX_PARKED_STEERS = MAX_PENDING_STEERS;

/**
 * Cap on tracked sessions. Long-lived servers see unboundedly many
 * session ids; the oldest box is evicted first (Map insertion order).
 */
export const MAX_PARKED_SESSIONS = 256;

interface Box {
  entries: UndeliveredSteer[];
  /**
   * Messages lost to {@link MAX_PARKED_STEERS} that the host has not
   * acknowledged yet. Counts down through `ackDiscarded`, never through
   * the entry cursor: the two are separate acks because they carry
   * separate information.
   */
  discarded: number;
}

export class UndeliveredSteerStore {
  private nextSeq = 1;
  private readonly bySession = new Map<string, Box>();

  /**
   * Take ownership of everything a turn could not deliver. Returns the
   * entries that are now retrievable — the same objects, with the same
   * `seq`, that `list` will report — so the caller can also mirror them
   * onto a live response without that becoming a second copy of the
   * message.
   */
  park(sessionId: string, texts: readonly string[]): UndeliveredSteer[] {
    if (texts.length === 0) return [];
    const box = this.bySession.get(sessionId) ?? { entries: [], discarded: 0 };
    const parkedAt = Date.now();
    const parked = texts.map((text) => ({
      seq: this.nextSeq++,
      text,
      parkedAt,
    }));
    box.entries.push(...parked);
    const overflow = box.entries.length - MAX_PARKED_STEERS;
    if (overflow > 0) {
      box.discarded += overflow;
      box.entries.splice(0, overflow);
    }
    this.bySession.set(sessionId, box);
    this.evictOldestSessions();
    const retained = new Set(box.entries);
    return parked.filter((entry) => retained.has(entry));
  }

  /** Non-destructive listing, oldest first. */
  list(sessionId: string): readonly UndeliveredSteer[] {
    return this.bySession.get(sessionId)?.entries ?? [];
  }

  /**
   * How many messages this session lost to `MAX_PARKED_STEERS` and has
   * not been acknowledged for. Survives `ack` — see `ackDiscarded`.
   */
  discarded(sessionId: string): number {
    return this.bySession.get(sessionId)?.discarded ?? 0;
  }

  /**
   * Drop everything with `seq <= through` and report how many went.
   * The cursor comes from a prior `list`, so a message parked in
   * between carries a higher `seq` and is not swallowed by the ack.
   *
   * Deliberately does **not** touch `discarded`. The cursor covers the
   * entries the host was shown; the discarded messages were never in
   * that listing and have no `seq` the host could point at, so nothing
   * about acking the entries proves the loss notice was read.
   */
  ack(sessionId: string, through: number): number {
    const box = this.bySession.get(sessionId);
    if (!box) return 0;
    const before = box.entries.length;
    box.entries = box.entries.filter((entry) => entry.seq > through);
    const acked = before - box.entries.length;
    this.reapIfEmpty(sessionId, box);
    return acked;
  }

  /**
   * Acknowledge up to `count` discarded messages and report how many
   * that actually cleared.
   *
   * Separate from `ack` on purpose. A host that acks the highest `seq`
   * it was given — before, or in the same pass as, reading `discarded`
   * — must not thereby erase the "N messages were dropped" signal and
   * be told on its next `GET` that nothing was lost. And it is a count,
   * not a flag, so discards that happen between the host's `GET` and
   * this call stay outstanding rather than being cleared unseen: the
   * same cursor discipline as the entries, applied to a counter.
   */
  ackDiscarded(sessionId: string, count: number): number {
    const box = this.bySession.get(sessionId);
    if (!box) return 0;
    const cleared = Math.min(Math.max(count, 0), box.discarded);
    box.discarded -= cleared;
    this.reapIfEmpty(sessionId, box);
    return cleared;
  }

  /** Forget one session's parked messages (session purge). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Forget everything (server shutdown / tests). */
  clearAll(): void {
    this.bySession.clear();
  }

  /**
   * How many sessions currently hold a box. Introspection only — the
   * seam that lets a test assert a box outlives its entries while a
   * loss is unacknowledged, and is reclaimed once it is not.
   */
  get trackedSessions(): number {
    return this.bySession.size;
  }

  /**
   * Drop a box that has nothing left to say — no entries and no
   * unacknowledged loss — so an idle server does not hold rows for
   * sessions nobody is asking about. A box kept alive only by
   * `discarded` is still reclaimed by `clear` (session purge) and by
   * `MAX_PARKED_SESSIONS` eviction, so this cannot grow without bound.
   */
  private reapIfEmpty(sessionId: string, box: Box): void {
    if (box.entries.length === 0 && box.discarded === 0) {
      this.bySession.delete(sessionId);
    }
  }

  private evictOldestSessions(): void {
    while (this.bySession.size > MAX_PARKED_SESSIONS) {
      const oldest = this.bySession.keys().next();
      if (oldest.done) return;
      this.bySession.delete(oldest.value);
    }
  }
}
