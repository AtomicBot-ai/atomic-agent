/**
 * How long `shutdown` waits for turns that were told to stop to write
 * their own end before it closes the session store under them.
 *
 * A stopped turn settles in milliseconds — the aborted request rejects,
 * the loop records `cancelled`, `executeTurn` saves — so this only runs
 * out on a turn stuck in work that ignores its signal. It has to fit
 * well inside the desktop app's stop, which sends SIGTERM and kills the
 * process 4 s later, with the rest of teardown still to run after it.
 */
export const SHUTDOWN_TURN_GRACE_MS = 1_500;

interface InFlightTurn {
  readonly signal: AbortSignal | undefined;
  readonly settled: Promise<void>;
}

/**
 * The turns `executeTurn` is running right now, for `shutdown` to wait
 * on before it closes the session store.
 *
 * Every host stops its own turns before it shuts the runtime down —
 * `serve` drops the connections (and its server's `close()` resolves
 * only once every request has seen that), the TUI and the sidecar abort
 * their controllers, the channels abort theirs as they stop — but
 * shutdown then closed the store at once, while those turns were still
 * unwinding.
 * A turn that lost that race could not write its end: its row kept
 * whatever it held before the turn, so a chat cancelled by quitting the
 * app looked like one where nothing had happened. Seen in a user's
 * database: two turns cancelled in the same second by a quit, one row
 * `cancelled`, the other still `pending` with no turn in it.
 */
export class TurnsInFlight {
  private readonly turns = new Set<InFlightTurn>();

  /**
   * Register a turn that is starting. Call `end()` once it has written
   * its end, or failed to; calling it twice is harmless.
   */
  begin(signal: AbortSignal | undefined): { end(): void } {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const turn: InFlightTurn = { signal, settled };
    this.turns.add(turn);
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.turns.delete(turn);
        resolveSettled();
      },
    };
  }

  /** Turns registered and not yet ended. */
  get size(): number {
    return this.turns.size;
  }

  /**
   * Wait, at most `graceMs`, for every turn whose signal has aborted to
   * end. A turn nobody stopped is not waited for: it is running work —
   * a scheduled task, most likely — that will not end on its own any time
   * soon, and its row is released as interrupted instead. Resolves to the
   * number of stopped turns still running when the wait gave up.
   *
   * The timer is deliberately not `unref`'d: shutdown awaits this, and a
   * process whose only remaining handle is this timer must still come
   * back to finish closing its stores.
   */
  async settleCancelled(graceMs: number): Promise<number> {
    const cancelling = [...this.turns].filter(
      (turn) => turn.signal?.aborted === true,
    );
    if (cancelling.length === 0) return 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([
        Promise.all(cancelling.map((turn) => turn.settled)),
        graceOver,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return cancelling.filter((turn) => this.turns.has(turn)).length;
  }
}
