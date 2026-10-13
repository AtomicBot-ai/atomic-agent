/**
 * The quit's shutdown (main.ts before-quit), as one sequence bounded step by
 * step and as a whole: the agent's close, then the model server's stop, then
 * the last analytics flush.
 *
 * Item 30 made every Quit wait for this sequence, so anything in it that does
 * not settle holds the app open. The agent's close had no bound of its own
 * (it also waits out a start on its way), and the other steps' bounds were
 * chained one after another (the close up to ~12 s even when it does settle,
 * the config read before the model server's stop up to 8 s, the stop up to
 * ~7 s, the flush 2 s), so the app could outlive T30's 30 s window with the
 * model server's stop not even begun. Now:
 *
 *  - the agent's close is bounded here (`closeMs`): an agent still going by
 *    then is the stop's to deal with, not the quit's to wait for;
 *  - the model server's stop always runs after it, whatever the close did;
 *  - the whole sequence has a ceiling (`totalMs`), after which the quit goes
 *    on regardless. The stop kills what its pid files name itself
 *    (stopDaemonForQuit), so the ceiling only matters when something else
 *    stalls.
 *
 * Background work (the Core update check, list fetches) is not part of this
 * sequence and is never awaited by it: main.ts aborts it as the quit begins.
 */

export interface QuitSteps {
  /** Stop `atag serve` for good (AgentClient.close). */
  closeAgent: () => Promise<unknown>;
  /** `localModels.managed.stopOnExit`: stop the model server (stopLocalDaemonOnQuit). */
  stopModelServer: () => Promise<unknown>;
  /** The last analytics flush (already bounded by analytics itself). */
  flush: () => Promise<unknown>;
}

export interface QuitBounds {
  closeMs: number;
  totalMs: number;
}

/** Comfortably inside the 30 s a quit may take (T30), with room for the stop after a slow close. */
export const QUIT_BOUNDS: QuitBounds = { closeMs: 10_000, totalMs: 25_000 };

export type QuitOutcome = "done" | "timed-out";

/** `p`, or `fallback` once `ms` have passed; never rejects; the timer never holds the process. */
export function settleWithin<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** A step that may throw synchronously, as a promise that never rejects. */
function step(run: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(run).catch(() => undefined);
}

/** Run the quit's shutdown; answers once it is over or its ceiling is reached. */
export function runQuitShutdown(steps: QuitSteps, bounds: QuitBounds = QUIT_BOUNDS): Promise<QuitOutcome> {
  const sequence = settleWithin(step(steps.closeAgent), bounds.closeMs, undefined)
    .then(() => step(steps.stopModelServer))
    .then(() => step(steps.flush))
    .then((): QuitOutcome => "done");
  return settleWithin(sequence, bounds.totalMs, "timed-out" as const);
}
