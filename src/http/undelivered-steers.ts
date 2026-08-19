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
 * Per-session cap. The inbox refuses past `MAX_PENDING_STEERS`, so one
 * turn can never hand back more than that; the cap only bites when
 * several turns strand messages and nobody ever acks. Past it the
 * oldest entries go — and `discarded` counts them, so a host that comes
 * back late learns it lost some instead of quietly seeing a short list.
 */
export const MAX_PARKED_STEERS = MAX_PENDING_STEERS;

/**
 * Cap on tracked sessions. Long-lived servers see unboundedly many
 * session ids; the oldest box is evicted first (Map insertion order).
 */
export const MAX_PARKED_SESSIONS = 256;

interface Box {
  entries: UndeliveredSteer[];
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

  /** How many messages this session lost to `MAX_PARKED_STEERS`. */
  discarded(sessionId: string): number {
    return this.bySession.get(sessionId)?.discarded ?? 0;
  }

  /**
   * Drop everything with `seq <= through` and report how many went.
   * The cursor comes from a prior `list`, so a message parked in
   * between carries a higher `seq` and is not swallowed by the ack.
   */
  ack(sessionId: string, through: number): number {
    const box = this.bySession.get(sessionId);
    if (!box) return 0;
    const before = box.entries.length;
    box.entries = box.entries.filter((entry) => entry.seq > through);
    const acked = before - box.entries.length;
    // Everything the host was told about is now acknowledged, the
    // discard notice included; drop the box so an idle server does not
    // hold rows for sessions nobody is asking about.
    if (box.entries.length === 0) this.bySession.delete(sessionId);
    return acked;
  }

  /** Forget one session's parked messages (session purge). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Forget everything (server shutdown / tests). */
  clearAll(): void {
    this.bySession.clear();
  }

  private evictOldestSessions(): void {
    while (this.bySession.size > MAX_PARKED_SESSIONS) {
      const oldest = this.bySession.keys().next();
      if (oldest.done) return;
      this.bySession.delete(oldest.value);
    }
  }
}
