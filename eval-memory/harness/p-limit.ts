/**
 * Tiny concurrency limiter. Returns a wrapper that schedules at most
 * `concurrency` simultaneous in-flight promises and FIFO-queues the
 * rest. Mirrors the well-known `p-limit` package's contract but lives
 * in-tree (no extra dependency) and ships under 60 LOC of pure logic
 * so the campaign harness stays self-contained.
 *
 * Usage:
 *
 *   const limit = pLimit(3);
 *   const results = await Promise.all(
 *     items.map((it) => limit(() => fetchSomething(it))),
 *   );
 *
 * Failures isolate per-task: a rejection on task N never aborts
 * scheduled siblings. The wrapper does not retry — wrap the task body
 * in a retry helper (see `harness/judge.ts > scoreWithRetry`) when
 * that is the desired behaviour.
 */

export interface ConcurrencyLimiter {
  /** Run a task subject to the concurrency cap. Resolves/rejects with the task's outcome. */
  <T>(task: () => Promise<T>): Promise<T>;
  /** Number of tasks currently executing (0..concurrency). */
  readonly activeCount: number;
  /** Number of tasks waiting for a slot. */
  readonly pendingCount: number;
}

export interface PLimitOptions {
  /** Hard cap on simultaneous in-flight tasks. Must be a positive integer. */
  concurrency: number;
}

export function pLimit(arg: number | PLimitOptions): ConcurrencyLimiter {
  const concurrency =
    typeof arg === "number" ? arg : arg.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `pLimit: concurrency must be a positive integer, got ${String(concurrency)}`,
    );
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active -= 1;
    const cont = queue.shift();
    if (cont) cont();
  };

  const limiter = <T,>(task: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        // Run task on a microtask so its synchronous part does not
        // re-enter `next()` before `active` reflects this slot.
        Promise.resolve()
          .then(task)
          .then(
            (v) => {
              next();
              resolve(v);
            },
            (e) => {
              next();
              reject(e instanceof Error ? e : new Error(String(e)));
            },
          );
      };
      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };

  // NOTE: `Object.assign` copies accessors as VALUES (evaluated once
  // at copy time), so we attach the getters with `defineProperty` to
  // preserve their live-read semantics.
  return Object.defineProperties(limiter as ConcurrencyLimiter, {
    activeCount: { get: () => active, enumerable: true },
    pendingCount: { get: () => queue.length, enumerable: true },
  });
}
