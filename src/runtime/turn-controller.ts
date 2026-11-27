import type { AgentLoopEvent } from "../agent/agent-contract.js";

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
  | "telegram"
  | "discord"
  /** A message from the Signal channel (ATO-629). */
  | "signal"
  /** A message from the Slack channel (ATO-499). */
  | "slack"
  | "imessage"
  | "matrix"
  | "googlechat"
  /** A message from the Microsoft Teams channel (ATO-506). */
  | "msteams"
  /** A message from the WhatsApp channel (ATO-502). */
  | "whatsapp"
  /** A mention or assignment in a Linear issue (ATO-2324). */
  | "linear"
  /**
   * A fusion worker turn, submitted by the orchestrator turn on the
   * parent session — not a person sending a message. Treated like
   * `scheduler` wherever origin gates analytics or the usage meter.
   */
  | "fusion"
  /**
   * A subagent worker turn (ATO-1669), submitted by a parent turn through
   * the shared worker runner. Also a worker, not a person: treated exactly
   * like `fusion` wherever origin is checked.
   */
  | "subagent";

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
  /**
   * ATO-2519: why a scheduled turn woke (`session.metadata.wakeReason.source`:
   * "scheduler", "webhook", "file", ...). Reported with the turn by
   * `busyTurns()`; the controller never branches on it.
   */
  wakeReason?: string;
}

/**
 * ATO-2519: one turn with a `run()` body in flight, as `busyTurns()`
 * reports it: where it came from, and for a scheduled turn why it woke.
 */
export interface BusyTurn {
  sessionId: string;
  origin: TurnOrigin;
  wakeReason?: string;
}

/**
 * ATO-2519: `session.metadata.wakeReason.source` (stamped by
 * `TaskRunner` before a scheduled turn), or undefined when there is none.
 */
export function wakeReasonSource(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const wake = metadata?.["wakeReason"];
  if (!wake || typeof wake !== "object") return undefined;
  const source = (wake as { source?: unknown }).source;
  return typeof source === "string" && source.length > 0 ? source : undefined;
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
  /** Session id to the turn running on it (one per session: the FIFO allows no more). */
  private readonly busy = new Map<string, BusyTurn>();
  private readonly onHookError?: (
    err: unknown,
    context: { sessionId: string; origin: TurnOrigin },
  ) => void;

  constructor(
    opts: {
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
    } = {},
  ) {
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
    const { sessionId, eventHook, signal, run, origin, wakeReason } = submission;
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

    // Whether this submission ever reached the front of the queue. The
    // lock it holds is only ever "the turn ahead of me is over", so a
    // submission that gave up while still waiting must not hand that
    // lock on until the turn ahead of it really is over.
    let reachedFront = false;
    try {
      // Wait for our turn while listening for the abort signal, so a
      // submission queued behind a long-running one can be cancelled
      // without ever calling `run()`.
      await waitOrAbort(previousSettled, signal);
      reachedFront = true;
      if (eventHook) {
        this.currentHooks.set(sessionId, eventHook);
      }
      this.busy.set(sessionId, { sessionId, origin, ...(wakeReason ? { wakeReason } : {}) });
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
      // if `run()` threw or the signal aborted before it started — but
      // a waiter that was cancelled in the queue releases only once its
      // predecessor settles. Releasing at the moment of the abort let
      // the submission queued behind it start while the turn ahead of
      // both was still running: two `run()`s on one session, which is
      // exactly what this class exists to rule out (and what
      // `SlotManager` relies on).
      const settle = (): void => {
        release();
        // Garbage-collect the queue entry when nothing else is waiting:
        // the resolved promise we leave behind keeps the Map from
        // growing unboundedly across throwaway sessions. Done with the
        // release, so a new submission arriving while a cancelled waiter
        // is still standing in for the running turn queues behind it.
        if (this.queues.get(sessionId) === ownTurn) {
          this.queues.delete(sessionId);
        }
      };
      if (reachedFront) settle();
      else void previousSettled.then(settle);
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
    return [...this.busy.keys()];
  }

  /**
   * ATO-2519: the same turns as `busySessionIds()`, each with its origin
   * (and wake reason), so a caller can say what is running: a Telegram
   * reply, an API request, a scheduled task. Copies, in start order.
   */
  busyTurns(): readonly BusyTurn[] {
    return [...this.busy.values()].map((t) => ({ ...t }));
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
