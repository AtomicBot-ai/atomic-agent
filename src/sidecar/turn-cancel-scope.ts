/**
 * The abort signal the sidecar hands to its turns (ATO-1645).
 *
 * The session used to own one AbortController for its whole life. A
 * `cancel` aborted it and nothing armed a new one, so every later
 * `send_message` passed an already-aborted signal: the turn controller
 * refused it at once and the turn ended as cancelled. Only a new session
 * helped.
 *
 * A `send_message` takes `signal` when it arrives. `cancel` aborts that
 * signal (the running turn and any turn queued behind it, as before) and
 * arms a fresh one, so the next message runs normally in the same session.
 * Same contract as Codex app-server `turn/interrupt` and the Claude Agent
 * SDK `interrupt()`: stop the turn in flight, keep the conversation.
 */
export class TurnCancelScope {
  private controller = new AbortController();

  /** The signal for a turn that starts now. Read it once, at request entry. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Abort every turn holding the current signal and arm a fresh one for
   * the turns that come after. The fresh controller is in place before
   * the abort runs, so an abort listener that reads `signal` sees it.
   */
  cancel(): void {
    const stopped = this.controller;
    this.controller = new AbortController();
    stopped.abort();
  }

  /** Session teardown: abort the current signal without arming a new one. */
  dispose(): void {
    this.controller.abort();
  }
}
