import type { ApprovalRequest } from "./approval-gate.js";

/**
 * Sink for one approval request. Always invoked synchronously by
 * `ApprovalRouter.emit`; the runtime never awaits a handler — handlers
 * that need to do async work (send a Telegram message, edit a TUI
 * dialog) own their own scheduling.
 */
export type ApprovalHandler = (request: ApprovalRequest) => void;

/**
 * Per-session dispatch for `ApprovalRequest`s. The runtime constructs
 * one router with a `fallback` (the host's `onApprovalRequest`
 * callback) and calls `emit` from inside `ApprovalGate`. Channels that
 * own a session — currently the Telegram channel, future Slack/etc. —
 * register a per-session handler via `setForSession` so the operator
 * sees the prompt on the surface that originated the turn instead of
 * a (possibly absent) host UI.
 *
 * Locked invariants — pinned by the colocated test file:
 *
 * 1. **Per-session dispatch wins over the fallback.** Once a per-
 *    session handler is registered, every `emit` whose `sessionId`
 *    matches goes to the handler; the fallback is never called for
 *    that session until it is unsubscribed.
 * 2. **Single handler per session.** A second `setForSession(id, h)`
 *    replaces the first; calling the first registration's
 *    `unsubscribe` after the replacement is a no-op (it does NOT
 *    remove the new handler).
 * 3. **Fallback for unrouted sessions.** Sessions without a
 *    registration always go to the fallback, including TUI / CLI /
 *    HTTP turns and Telegram turns received while the channel is
 *    starting up or rotating sessions via `/new`.
 */
export class ApprovalRouter {
  private readonly perSession = new Map<string, ApprovalHandler>();

  constructor(private readonly fallback: ApprovalHandler) {}

  /**
   * Register `handler` for `sessionId`. Returns an `unsubscribe`
   * function that removes the registration **only** when the current
   * registration is still `handler`; if a later `setForSession` has
   * already replaced it, the unsubscribe is a no-op. This keeps the
   * lifecycle of a long-lived channel safe across session rotations.
   */
  setForSession(sessionId: string, handler: ApprovalHandler): () => void {
    this.perSession.set(sessionId, handler);
    return () => {
      if (this.perSession.get(sessionId) === handler) {
        this.perSession.delete(sessionId);
      }
    };
  }

  /**
   * Dispatch a request. Per-session handler wins; fallback is the
   * default for everything else.
   */
  emit(request: ApprovalRequest): void {
    const handler = this.perSession.get(request.sessionId) ?? this.fallback;
    handler(request);
  }

  /** Snapshot of currently routed session ids. Diagnostic only. */
  routedSessions(): readonly string[] {
    return [...this.perSession.keys()];
  }
}
