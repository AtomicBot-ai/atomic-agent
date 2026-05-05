import type { AgentLoopEvent } from "../agent/agent-loop.js";

/**
 * Where the turn submission originated. Used for observability and as
 * the canonical extension point for future schedulers (Option 4) — the
 * controller itself does not branch on origin, but downstream consumers
 * (recorder, metrics, scheduler audit) can.
 */
export type TurnOrigin =
  | "cli"
  | "tui"
  | "http"
  | "sidecar"
  | "scheduler"
  | "telegram";

/**
 * Per-turn event sink. Installed atomically when a submission starts
 * running and cleared the moment the body settles, so events from a
 * cancelled or finished turn never leak into the next submission on
 * the same session.
 */
export type TurnEventHook = (event: AgentLoopEvent) => void;

export interface TurnSubmission<T> {
  sessionId: string;
  origin: TurnOrigin;
  /**
   * The actual turn body. The controller awaits this once it owns the
   * per-session lock; the body is expected to call into
   * `AgentLoop.runTurn` (directly or via `runtime.runTurn`).
   */
  run: () => Promise<T>;
  /**
   * Optional per-submission event hook. Receives every `AgentLoopEvent`
   * emitted via `controller.emit(sessionId, event)` during the lifetime
   * of `run()`. Two submissions on different sessions never share a
   * hook; two submissions on the same session swap hooks atomically at
   * the FIFO boundary.
   */
  eventHook?: TurnEventHook;
  /**
   * Optional cancellation channel for waiting submissions. When the
   * signal aborts before the submission acquires the per-session lock,
   * the queue entry is dropped and `enqueue()` rejects with the abort
   * reason — `run()` is never invoked. Once `run()` starts, cancellation
   * is the body's responsibility (typically by forwarding the same
   * signal into `runTurn`).
   */
  signal?: AbortSignal;
}

/**
 * Single per-session turn-ownership primitive used by every entry
 * point — CLI, TUI, HTTP, sidecar, and the future scheduler. Two
 * invariants:
 *
 * 1. **Per-session FIFO.** At most one `run()` runs concurrently for a
 *    given `sessionId`. Submissions on the same session run in the
 *    order they were enqueued.
 * 2. **Cross-session parallelism.** Submissions for different
 *    `sessionId`s never block each other.
 *
 * The controller also routes per-turn events: when a submission's body
 * (or any downstream component owned by the runtime) calls
 * `controller.emit(sessionId, event)`, only that submission's
 * `eventHook` receives it. There is no global hook fan-out — this is
 * how the scheduler can attach its own event sink without colliding
 * with a concurrent user turn on a different session.
 *
 * Failures in `run()` propagate to the caller of `enqueue()` and never
 * break the queue: subsequent submissions on the same session still
 * drain in FIFO order. Failures in `eventHook()` are swallowed and
 * logged via `onHookError`; an event sink should never be able to take
 * down the agent loop.
 */
export class TurnController {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly currentHooks = new Map<string, TurnEventHook>();
  private readonly busy = new Set<string>();
  private readonly onHookError?: (
    err: unknown,
    context: { sessionId: string; origin: TurnOrigin },
  ) => void;

  constructor(opts: {
    /**
     * Optional sink for `eventHook` failures. Called once per thrown
     * value with the originating session id and submission origin.
     * When unset, hook errors are swallowed silently — the queue is
     * never affected either way.
     */
    onHookError?: (
      err: unknown,
      context: { sessionId: string; origin: TurnOrigin },
    ) => void;
  } = {}) {
    if (opts.onHookError) this.onHookError = opts.onHookError;
  }

  /**
   * Submit a turn for the given session. Resolves with the value
   * returned by `run()` once it completes, or rejects with the same
   * error. Behaviour:
   *
   *  - If the session is idle, `run()` starts on the next microtask.
   *  - If the session is busy, the submission waits behind the in-flight
   *    one (and any earlier waiters), preserving FIFO order.
   *  - If `signal` aborts before `run()` starts, the submission is
   *    dropped from the queue and the promise rejects with the abort
   *    reason — `run()` never executes.
   *  - If `run()` throws, the rejection propagates but the queue
   *    survives.
   */
  async enqueue<T>(submission: TurnSubmission<T>): Promise<T> {
    const { sessionId, eventHook, signal, run } = submission;
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const previousSettled = previous.catch(() => undefined);
    let release!: () => void;
    const ownTurn = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.queues.set(sessionId, ownTurn);

    try {
      // Wait for our turn while listening for the abort signal, so a
      // submission queued behind a long-running one can be cancelled
      // without ever calling `run()`.
      await waitOrAbort(previousSettled, signal);
      if (eventHook) {
        this.currentHooks.set(sessionId, eventHook);
      }
      this.busy.add(sessionId);
      try {
        return await run();
      } finally {
        this.busy.delete(sessionId);
        if (eventHook) {
          this.currentHooks.delete(sessionId);
        }
      }
    } finally {
      // Always release the lock so the next waiter can proceed, even
      // if `run()` threw or the signal aborted before it started.
      release();
      // Garbage-collect the queue entry when nothing else is waiting:
      // the resolved promise we leave behind keeps the Map from
      // growing unboundedly across throwaway sessions.
      if (this.queues.get(sessionId) === ownTurn) {
        this.queues.delete(sessionId);
      }
    }
  }

  /**
   * Forward an agent-loop event to the active submission's hook.
   * No-op when no submission is currently running for `sessionId` —
   * stale events from a cancelled turn never leak to the next one.
   */
  emit(sessionId: string, event: AgentLoopEvent): void {
    const hook = this.currentHooks.get(sessionId);
    if (!hook) return;
    try {
      hook(event);
    } catch (err) {
      this.onHookError?.(err, {
        sessionId,
        // `origin` is not tracked alongside the hook (the hook closure
        // is the source of truth), so we report `"http"` as a neutral
        // default. Hook errors are diagnostic only — the loss of
        // origin tagging here is acceptable.
        origin: "http",
      });
    }
  }

  /** True when a submission is currently `run()`ing for `sessionId`. */
  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  /**
   * Snapshot of all session ids that have a `run()` body in flight.
   * Useful for the future scheduler to pick "skip this tick" when too
   * many sessions are already executing.
   */
  busySessionIds(): readonly string[] {
    return [...this.busy];
  }
}

/**
 * Extract the abort reason as a thrown value. Browser/Node alignment:
 * `signal.reason` is the conventional carrier; when absent (older
 * runtimes) we fall back to a synthesised `DOMException("aborted",
 * "AbortError")` which `classifyFailure` already understands.
 */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined && signal.reason !== null) {
    return signal.reason;
  }
  return new DOMException("aborted", "AbortError");
}

/**
 * Await a promise while honouring an optional abort signal. When the
 * signal fires before the promise settles, the returned promise rejects
 * with `signal.reason` (and the original promise's eventual settlement
 * is ignored). When the signal is absent, the function degenerates into
 * a plain `await`.
 */
function waitOrAbort(
  p: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return p.then(() => undefined);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolvePromise, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    p.then(
      () => {
        cleanup();
        resolvePromise();
      },
      () => {
        cleanup();
        resolvePromise();
      },
    );
  });
}
