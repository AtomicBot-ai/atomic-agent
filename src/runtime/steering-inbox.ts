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

/**
 * The turn's side of the inbox: open the gate when the turn starts
 * accepting steers, drain at each step boundary, and close+drain in one
 * step on the way out. Declared narrow so `AgentLoop` never sees `push`.
 */
export interface SteeringChannel {
  open(sessionId: string): void;
  drain(sessionId: string): readonly string[];
  closeAndDrain(sessionId: string): readonly string[];
}

export class SteeringInbox implements SteeringChannel {
  private readonly bySession = new Map<string, string[]>();
  /**
   * Sessions whose running turn is still willing to pick messages up.
   * This — not `TurnController.isBusy` — is what `push` gates on.
   *
   * `isBusy` and "a step boundary is still coming" are two different
   * facts that stop being true at two different moments: the loop does
   * its final drain inside `runTurn`, while the controller clears
   * `busy` later, in its own `finally`. A `push` in that window used to
   * be accepted (busy was still true) and then sat here until some
   * unrelated later turn drained it — the operator saw the message
   * accepted and the running turn never saw it. Making acceptance a
   * property of *this* object, flipped by the same call that performs
   * the final drain, collapses the two facts into one.
   */
  private readonly accepting = new Set<string>();

  /**
   * Start accepting steers for the turn now running on `sessionId`.
   * Called by `AgentLoop.runTurn` on entry. Idempotent.
   */
  open(sessionId: string): void {
    this.accepting.add(sessionId);
  }

  /** True while a turn on `sessionId` can still pick messages up. */
  isOpen(sessionId: string): boolean {
    return this.accepting.has(sessionId);
  }

  /**
   * Queue a message for the turn currently running on `sessionId`.
   * Returns `false` when no turn is accepting steers for that session,
   * when the text is blank, or when the per-session cap is reached —
   * callers treat any `false` as "not steered, park it instead".
   */
  push(sessionId: string, text: string): boolean {
    if (!this.accepting.has(sessionId)) return false;
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

  /**
   * Stop accepting and take what is left, as a single indivisible step.
   *
   * This is the turn's LAST act on the inbox. Everything returned here
   * is `RunTurnResult.undelivered` — the caller's to re-route. Every
   * `push` that lands after it is refused, so the sender is told "not
   * steered" while the fact is still true, instead of being told "yes"
   * and having the text stranded until an unrelated later turn.
   *
   * Idempotent: a second call returns `[]`.
   */
  closeAndDrain(sessionId: string): readonly string[] {
    this.accepting.delete(sessionId);
    return this.drain(sessionId);
  }

  /** Non-destructive read, for UI badges and tests. */
  peek(sessionId: string): readonly string[] {
    // A copy: the readonly type does not stop the live array from
    // mutating under a caller that cached it across a push.
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** Discard pending messages for one session (session switch / abort). */
  clear(sessionId: string): void {
    this.accepting.delete(sessionId);
    this.bySession.delete(sessionId);
  }

  /** Discard everything (runtime shutdown). */
  clearAll(): void {
    this.accepting.clear();
    this.bySession.clear();
  }
}
