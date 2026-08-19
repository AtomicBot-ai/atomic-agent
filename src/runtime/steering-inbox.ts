/**
 * Per-session mailbox for user messages that arrive **while a turn is
 * already running**.
 *
 * The runtime has exactly one ordered path into `AgentLoop.runTurn`
 * (`TurnController`, per-session FIFO), and that is deliberate: two
 * concurrent turns on one session would race the browser, the slot
 * manager and the transcript. But FIFO also means a message sent
 * mid-turn cannot reach the model until the current turn closes, which
 * is the wrong answer when the operator is watching the agent walk off
 * a cliff and wants to redirect it *now*.
 *
 * This inbox is the out-of-band channel for exactly that. It does not
 * start turns and it does not touch the queue: `AgentLoop` drains it at
 * the top of every step and folds the text into that step's `### notice`
 * block. The effect lands at the next **step** boundary — never
 * mid-inference, and never mid-tool-call.
 *
 * Ownership mirrors `TurnController`: one instance per runtime, keyed by
 * session id, and cross-session isolated by construction.
 */

/**
 * Maximum messages held for one session before `push` starts refusing.
 * A turn stuck in a long tool call can be steered a handful of times
 * before the model gets a chance to read any of them; past that the
 * caller should queue instead of piling more onto one prompt. Refusing
 * is safer than dropping the oldest — the caller learns the message did
 * not land and can park it.
 */
export const MAX_PENDING_STEERS = 16;

/** Narrow read side, so `AgentLoop` never sees the mutating surface. */
export interface SteeringDrain {
  drain(sessionId: string): readonly string[];
}

export class SteeringInbox implements SteeringDrain {
  private readonly bySession = new Map<string, string[]>();

  /**
   * Queue a message for the turn currently running on `sessionId`.
   * Returns `false` when the text is blank or the per-session cap is
   * reached — callers treat that as "not steered, park it instead".
   */
  push(sessionId: string, text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    const pending = this.bySession.get(sessionId);
    if (pending === undefined) {
      this.bySession.set(sessionId, [trimmed]);
      return true;
    }
    if (pending.length >= MAX_PENDING_STEERS) return false;
    pending.push(trimmed);
    return true;
  }

  /**
   * Take everything pending for `sessionId` and empty the slot. Always
   * returns an array (possibly empty) so callers never branch on
   * `undefined`.
   */
  drain(sessionId: string): readonly string[] {
    const pending = this.bySession.get(sessionId);
    if (pending === undefined || pending.length === 0) return [];
    this.bySession.delete(sessionId);
    return pending;
  }

  /** Non-destructive read, for UI badges and tests. */
  peek(sessionId: string): readonly string[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** Discard pending messages for one session (session switch / abort). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Discard everything (runtime shutdown). */
  clearAll(): void {
    this.bySession.clear();
  }
}
