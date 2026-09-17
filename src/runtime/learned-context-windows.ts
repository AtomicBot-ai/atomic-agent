/**
 * Context windows the model server revealed, keyed by provider and
 * model, kept for the life of the process.
 *
 * Two kinds of evidence move a window, in opposite directions:
 *
 *  - `observe(key, window)`: the server cut a reply short at the window,
 *    or refused a request as too large for it — the window is at most
 *    this. A smaller observation replaces a larger one.
 *  - `raise(key, tokens)`: a completion whose prompt + reply exceeded
 *    the believed window succeeded — the window is at least this. The
 *    learned window grows to it.
 *
 * It used to be forgotten instead of raised, which threw the learning
 * away the first time the server served one token more than believed
 * and sent the next prompt back to the catalogue's nominal 128k — from
 * where the next refusal had to learn it all over again. A window only
 * ever moves towards what the server demonstrated; it never resets.
 */
export class LearnedContextWindows {
  private readonly windows = new Map<string, number>();

  /** The learned window for `key`, when any. */
  get(key: string): number | undefined {
    return this.windows.get(key);
  }

  /** The server showed the window is at most `window`. */
  observe(key: string, window: number): void {
    if (!Number.isFinite(window) || window <= 0) return;
    const known = this.windows.get(key);
    this.windows.set(key, known === undefined ? window : Math.min(known, window));
  }

  /** The server just held `tokens`: the window is at least that. */
  raise(key: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const known = this.windows.get(key);
    if (known !== undefined && tokens > known) this.windows.set(key, tokens);
  }
}
