/**
 * One place that knows how to hand the terminal back.
 *
 * The TUI puts the host terminal into two non-default modes — the
 * alternate screen (`alt-screen.ts`) and mouse reporting
 * (`mouse/mouse-tracking.ts`) — and each used to carry its own
 * `process.once("exit")` net. That covered a clean exit and nothing
 * else: an uncaught exception reached the reporter in
 * `error-reporting/error-reporter.ts`, which flushes Sentry for up to
 * two seconds and prints the stack, all of it *inside the alt screen*
 * with the mouse still reporting. The operator saw the crash text
 * scroll away with the alt buffer and was left in a shell where every
 * click printed `64;62;21M` at the prompt.
 *
 * So the two modes register here instead, and this module owns the
 * process hooks:
 *
 *  - `exit` — the original net, unchanged in effect.
 *  - `uncaughtException`, **prepended** — runs before the reporter, so
 *    the stack it prints lands on the normal screen and the terminal is
 *    already clean while Sentry flushes.
 *
 * Restores run **LIFO**: modes are undone in the reverse of the order
 * they were entered, so mouse reporting stops before the alt screen is
 * left rather than after it, and a throwing stream cannot stop the
 * restores behind it.
 *
 * `unhandledRejection` is deliberately absent. The reporter treats it
 * as non-fatal on purpose — a long-lived agent should not die of one —
 * and tearing the screen down under a TUI that keeps running would turn
 * an observability event into a visible fault.
 *
 * **What this cannot cover.** A V8 fatal error — `JavaScript heap out
 * of memory` is the one that bit us — calls `abort()` from inside the
 * engine. No JavaScript runs after it, so no handler here (or anywhere)
 * fires. The only defence against that is not running out of heap; see
 * the `process.env.NODE_ENV` define in `scripts/bundle-sea.ts` (SEA
 * binary) and `src/cli/env-defaults.ts` (unbundled `dist` runs).
 */

type RestoreFn = () => void;

const restores: RestoreFn[] = [];
let hooksInstalled = false;

/**
 * Adds `restore` to the net and returns a function that takes it back
 * out. Callers that tear down normally should call the returned
 * unregister *before* running their own restore, exactly as the old
 * `process.off("exit", …)` pairing did — otherwise a mode that has
 * already been left would be left a second time at exit.
 */
export function registerTerminalRestore(restore: RestoreFn): () => void {
  restores.push(restore);
  installHooks();
  return () => {
    const index = restores.lastIndexOf(restore);
    if (index >= 0) restores.splice(index, 1);
  };
}

/**
 * Runs every registered restore, most recently registered first, and
 * empties the registry so a second call is a no-op. Each callback is
 * already idempotent; draining the list as well means the `exit` hook
 * cannot re-run work an `uncaughtException` just did.
 */
export function restoreTerminalNow(): void {
  while (restores.length > 0) {
    const restore = restores.pop();
    try {
      restore?.();
    } catch {
      // A closed or broken stdout must not stop the restores behind
      // this one — leaving the terminal in *one* wrong mode is better
      // than leaving it in two.
    }
  }
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", restoreTerminalNow);
  // `prependListener` rather than `on`: the reporter's handler is the
  // one that prints the stack and exits, and it should find a terminal
  // that has already been handed back.
  //
  // Safe with respect to that reporter's `soleUncaughtHandler` check,
  // which samples `listenerCount("uncaughtException")` when
  // `installGlobalErrorHandlers` runs — the runtime is bootstrapped
  // before the TUI enters any terminal mode, so this listener is always
  // added after the sample is taken and cannot make the reporter think
  // a host owns the crash path.
  process.prependListener("uncaughtException", restoreTerminalNow);
}

/** Test-only: drop the registry and let the hooks install again. */
export function resetTerminalRestoreForTests(): void {
  restores.length = 0;
  hooksInstalled = false;
  process.removeListener("exit", restoreTerminalNow);
  process.removeListener("uncaughtException", restoreTerminalNow);
}
