import type { AgentLoopEvent } from "../agent/agent-loop.js";

export type TurnEventHook = (event: AgentLoopEvent) => void;

/**
 * Serialises access to `runtime.runTurn` and routes per-turn events
 * back to whichever HTTP handler is currently driving a turn.
 *
 * Why: the shared agent runtime — browser backend, slot manager, tool
 * registry — is not safe for concurrent `runTurn` invocations. Atomic
 * agent's other frontends (CLI run, TUI) enforce this naturally because
 * they each own one terminal; the HTTP surface must do so explicitly.
 *
 * The hub also acts as a single sink for `onAgentEvent` emitted by the
 * runtime, forwarding to the hook installed by the active turn. Hooks
 * are swapped atomically at entry/exit of `runExclusive` so events for
 * a cancelled or finished turn never leak to the next one.
 */
export class TurnHub {
  private currentHook: TurnEventHook | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  emit(event: AgentLoopEvent): void {
    this.currentHook?.(event);
  }

  /**
   * Enqueue a turn-bound body so it runs after any in-flight turn
   * completes, with `hook` installed as the active event sink. Errors
   * thrown by the body propagate to the caller but do not break the
   * queue — subsequent turns still drain in FIFO order.
   */
  async runExclusive<T>(
    hook: TurnEventHook,
    body: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queue.catch(() => undefined);
    let release!: () => void;
    this.queue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    this.currentHook = hook;
    try {
      return await body();
    } finally {
      this.currentHook = null;
      release();
    }
  }
}
